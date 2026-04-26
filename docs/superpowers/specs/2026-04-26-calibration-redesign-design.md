# Calibration Redesign — Precision-Driven Open Loop

**Date:** 2026-04-26
**Status:** spec — awaiting user review

## Problem

Today's `calibrate_search_strategy` tool runs `search-strategist` (sonnet)
through a strict 3-round × 4-query loop. It optimises for **query-coverage
yield** (`usableQueries / queriesPerRound ≥ 0.5`) — i.e. "at least half my
queries find *something* worth queueing."

That bar is too cheap. A query can return 50 tweets, surface 1 queueable,
and still count as a "winning" query. Daily `discovery-scout` (currently
**haiku**, model-mismatched against strategist) then replays those queries
verbatim and the founder sees a queue dominated by noise.

The user's diagnosis: real-search precision feels bad. Too much junk in the
queue, too few "yes that's exactly the kind of thread I'd reply to" hits.

## Goals

1. Calibration optimises for **per-tweet precision** (% of tweets the
   strategist would queue), not query coverage.
2. Calibration model and daily scan model are **the same** so the rubric
   produces consistent verdicts across the two phases.
3. The 3-round straightjacket is replaced by an **open-ended LLM loop**
   bounded by total turn count — strategist decides when to evolve, when
   to retry, when to give up.
4. When the loop can't reach target before the budget runs out, deliver
   the **best-seen** strategy with an honest rationale rather than failing.

## Non-goals (deferred)

- **Re-calibration triggers** — the system still calibrates once per
  `(user, product, platform)` and then trusts the cached strategy
  indefinitely. The "strategy decays after N days" problem is real but
  out of scope here.
- **`negativeTerms` semantics** — they remain a judgment hint passed to
  scout, not an API-level filter or persistent denylist.
- **Discovery-reviewer model** — stays lightweight (haiku). Reviewer is a
  second-opinion noise detector; cost-tier mismatch with scout is fine.
- **Server-side precision recompute** — strategist self-reports
  `observedPrecision`. We trust it; observability comes from
  `sampleVerdicts`. Adding a server recompute would force persisting
  every verdict, which violates the "strategist emits a strategy doc,
  not scan results" boundary.

## Behaviour contract

| Aspect | Before | After |
|---|---|---|
| Stop condition | `usableQueries / queriesPerRound ≥ 0.5` | `queueableTweets / judgedTweets ≥ 0.7` **AND** `judgedTweets ≥ 20` |
| Loop structure | Strict 3 rounds × 4 queries, full regeneration each round | Open-ended; strategist picks one move per turn |
| Budget cap | `maxRounds = 3` | `maxTurns = 60` |
| On cap-hit | n/a (always reached the 3-round limit) | Deliver `BEST_SEEN.queries` + `reachedTarget: false` + candid rationale |
| Models | strategist=sonnet, scout=haiku (drift) | strategist=sonnet, scout=sonnet (aligned). Reviewer unchanged. |
| Min sample | none | `sampleSize ≥ 20` required to declare reach (avoids "1 hit = 100%" false positives) |

## Component changes

### `discovery-scout/AGENT.md`

Frontmatter only:

```diff
- model: claude-haiku-4-5-20251001
+ model: claude-sonnet-4-6
```

Prompt body unchanged — `presetQueries` verbatim-replay branch still
governs daily runs.

### `search-strategist/AGENT.md`

Replace the "Round 1 / Round 2 / Round 3" section with an iteration-loop
section. Frontmatter `maxTurns: 15 → 60` so `runAgent`'s harness-level
cap matches the prompt-level budget — these MUST stay in lockstep, since
the LLM will only honor the prompt-stated cap while `runAgent` enforces
the frontmatter value as a hard cutoff.

**New input declaration:**

```
platform, sources, product
targetPrecision: 0.7   (default)
maxTurns: 60           (default)
minSampleSize: 20      (default)
```

**"What precision means" (replaces "What yield means"):**

```
At any moment in the loop:
  judgedTweets   = unique tweets you've applied the rubric to so far
                   (deduplicate by externalId across iterations)
  queueableCount = of those, how many you'd queue
  precision      = queueableCount / judgedTweets

Target = 0.70. You also need judgedTweets ≥ 20 — anything less is too
small a sample to call the strategy proven.
```

**Iteration loop (replaces three-round structure):**

```
You run an open-ended loop. Each iteration is one move + one batch
search + judgment + decision. No fixed round count.

Track BEST_SEEN across iterations:
  { queries, precision, sampleSize }
Update it whenever the current sweep's precision exceeds it.

Also track per-query stats so swap-one knows what to drop:
  perQuery: Map<query, { judged, queueable }>

Each iteration, pick ONE move:
  (a) seed:       first iteration only — generate 4-8 queries from
                  sources / keywords / rubric positive signals.
  (b) swap-one:   replace the query with the lowest queueable/judged
                  ratio (require its judged ≥ 5 — drop on too-small
                  per-query sample is noise) with a new one targeting
                  the same intent.
  (c) narrow:     restrict an existing query (add operators, exclude
                  a noisy phrase, drop a generic term).
  (d) widen:      only when sampleSize is too small to judge —
                  loosen one query to bring in more candidates.
  (e) regenerate: full rewrite. Use only when the current set is
                  structurally wrong (dominant failure mode is
                  competitors / off-topic / stale).
  (f) retry:      re-run the same batch — useful to confirm a result
                  wasn't a fluke or to rotate the time window.
                  Costs a search call. Use sparingly.

Stop conditions (whichever first):
  S1. precision ≥ targetPrecision AND sampleSize ≥ minSampleSize
      → deliver the CURRENT iteration's queries (just-validated set).
  S2. turn budget exhausted (≤5 turns remain)
      → deliver BEST_SEEN.queries with reachedTarget=false and a
        candid rationale explaining the residual gap.
```

**Hard rules diff:**

- Remove "never exceed `maxRounds`".
- Add "Track turn count from input; when ≤5 remain, stop iterating
  and deliver `BEST_SEEN`."
- Add "Do NOT declare success on `sampleSize < minSampleSize`, even
  if precision is 1.0 — small-N noise."
- Keep "Don't invent queries you didn't actually run."
- Keep `negativeTerms` semantics (judgment hint only).

**Delivering**: schema fields per §4 below.

### Design rationale (kept inline so future readers see the trade-off)

- **Why S1 delivers `current` not `BEST_SEEN`?** Current is the just-
  validated set under today's data. `BEST_SEEN` may be from N iterations
  ago when timeline state differed; replaying it in production isn't
  guaranteed to still hit precision. S2 is the only path that uses
  `BEST_SEEN`, since by then there's no chance to re-validate.
- **Why move (f) retry is its own option?** Without it, strategist
  treats every "noisy timeline today" as "bad query" and churns
  unnecessarily. Allowing retry teaches it to confirm-before-changing.
- **Why move (e) regenerate is allowed but discouraged?** Most failure
  modes are local (one bad query, one too-broad term). Full rewrites
  burn turns and lose the partial signal that earlier iterations
  established. Reserve for "structurally wrong" diagnoses.

## Schemas

### `CalibrateSearchTool.inputSchema`

```ts
// before
const inputSchema = z.object({
  platform: z.enum(['x', 'reddit']),
  targetYield: z.number().min(0).max(1).optional(),
  queriesPerRound: z.number().int().min(1).max(8).optional(),
  maxRounds: z.number().int().min(1).max(5).optional(),
});

// after
const inputSchema = z.object({
  platform: z.enum(['x', 'reddit']),
  targetPrecision: z.number().min(0).max(1).optional(),  // default 0.7
  maxTurns: z.number().int().min(20).max(120).optional(), // default 60
  minSampleSize: z.number().int().min(5).max(200).optional(), // default 20
});
```

`buildStrategistMessage()` updates field names to match. Coordinator's
`calibrate_search_strategy({ platform })` call passes no overrides — it
runs on defaults — so `coordinator/AGENT.md` does **not** need to change.

**`maxTurns` dual-source caveat.** The strategist has TWO `maxTurns`
values in flight: the frontmatter (`AGENT.md` → `strategistConfig.maxTurns`,
enforced by `runAgent` as a hard cutoff) and the input field (visible to
the LLM in the prompt JSON, used for self-pacing). If a caller overrides
input `maxTurns`, `CalibrateSearchTool.execute` MUST also assign
`strategistConfig.maxTurns = effectiveMaxTurns` before invoking
`runAgent`, otherwise the LLM thinks it has more budget than the harness
allows and gets cut off mid-iteration. The default path
(no override) keeps both at 60 and avoids the issue.

### `searchStrategistOutputSchema`

```ts
// before
{
  queries: string[].min(1),
  negativeTerms: string[],
  rationale: string.min(1),
  observedYield: number(0..1),
  roundsUsed: int(1..3),
  sampleVerdicts: [{ url, queueable, reason }],
}

// after
{
  queries: string[].min(1),
  negativeTerms: string[],
  rationale: string.min(1),
  observedPrecision: number(0..1),       // replaces observedYield
  reachedTarget: boolean,                 // new
  turnsUsed: int(1..120),                 // replaces roundsUsed
  sampleSize: int.min(0),                 // new — total tweets judged
  sampleVerdicts: [{ url, queueable, reason }], // unchanged
}
```

`SearchStrategistOutput = z.infer<typeof schema>` flows everywhere via
type inference.

### `PersistedSearchStrategy` + persistence

```ts
// strategy-memory.ts
export interface PersistedSearchStrategy extends SearchStrategistOutput {
  platform: 'x' | 'reddit';
  generatedAt: string;
  schemaVersion: 2;   // 1 → 2
}
```

`CalibrateSearchTool.execute` writes `schemaVersion: 2` literally.

### `RunDiscoveryScanTool.loadStrategy()` — v1 rejection

```ts
function loadStrategy(raw, platform) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedSearchStrategy;
    if (parsed.schemaVersion !== 2) return null;   // NEW — reject v1
    if (parsed.platform !== platform) return null;
    if (!Array.isArray(parsed.queries) || parsed.queries.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}
```

Existing v1 entries → `loadStrategy` returns null → `run_discovery_scan`
returns `skipped: true, reason: 'strategy_not_calibrated'` → coordinator
auto-recalibrates on next discovery cron. Zero migration code, zero
back-compat shim. Aligns with the "v2 migration: no `-v2` aliasing,
single canonical tokens" memory.

### `CalibrateSearchStrategyResult`

```ts
// before
{ saved, reason?, platform, queries, observedYield, roundsUsed, rationale, costUsd }

// after
{ saved, reason?, platform, queries, observedPrecision, reachedTarget,
  turnsUsed, sampleSize, rationale, costUsd }
```

Coordinator's chat summary line updates from
`"Calibration: M queries, X% yield, ..."` to
`"Calibration: M queries, X% precision (target 70%, reached/not reached), ..."`.

## Edge cases

| Scenario | Handling |
|---|---|
| Search returns 0 candidates entirely | `sampleSize` stays 0; never reaches S1. Strategist must use move (d) widen or (e) regenerate. After repeated empties, deliver `reachedTarget: false` early with rationale "platform returned no candidates for this product." |
| Calibration ends with `sampleSize < minSampleSize` even at precision=1.0 | S2 path; `reachedTarget: false`; rationale states sample-size shortfall explicitly. |
| Strategist self-reports `observedPrecision` inconsistent with `sampleVerdicts` | Trusted as-is. Server-side recompute is non-goal (see §Non-goals). Operational guard is sample-verdict spot checks. |
| Strategist loops on retry without making progress | `maxTurns=60` cap forces termination; `BEST_SEEN` delivers; rationale exposes the loop. |

## Tests

| File | Change |
|---|---|
| `src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts` | Update mock strategist output to new schema; update input parameter names; assert persisted JSON has `schemaVersion: 2` |
| `src/tools/AgentTool/agents/search-strategist/__tests__/` (if present) | Same field renames |
| `src/lib/discovery/__tests__/v3-pipeline.test.ts` | Unchanged — pipeline only consumes `presetQueries` / `negativeTerms` |
| `src/tools/RunDiscoveryScanTool/__tests__/` (add if missing) | New case: v1 `schemaVersion` entry → `skipped: 'strategy_not_calibrated'` |

New unit tests:
- `loadStrategy()` rejects entry with `schemaVersion: 1`.
- `CalibrateSearchTool` default parameter values reach the prompt JSON
  (`targetPrecision=0.7`, `maxTurns=60`, `minSampleSize=20`).

## Known limitations (called out, not solved here)

1. **Calibration sample ≠ daily scan sample.** Even with 70% precision
   on calibration day, tomorrow's timeline can drop scout to 40%. Solving
   this requires re-calibration triggers (deferred, see Non-goals).
2. **Self-reported precision is not server-verified.** Strategist could
   in principle inflate `observedPrecision`. We mitigate via
   `sampleVerdicts` spot-checking and accept the small risk in exchange
   for keeping calibration's "strategy doc only, no verdict persistence"
   boundary clean.
3. **Cost.** Daily scout on sonnet is ~5× the haiku cost. Acceptable
   given the precision payoff; will revisit if multi-product / multi-
   platform fan-out scales the daily bill faster than expected.

## Rollout

1. Land schema + tool changes (this spec) — single PR.
2. v1 entries auto-fail loadStrategy → next discovery cron triggers a
   re-calibration on the new logic. No manual backfill.
3. Watch first 3-5 calibrations across real users for: turnsUsed
   distribution, reachedTarget rate, post-deploy queue noise (does
   founder approve rate go up?).
4. If `reachedTarget: false` rate is high (>40%), revisit `targetPrecision`
   default — 0.7 may be unattainable for some product/platform combos.

## Open questions surfaced during review

None — `negativeTerms` and re-calibration triggers were explicitly
deferred. Move (e) regenerate and S1 vs S2 delivery semantics confirmed
during brainstorming.
