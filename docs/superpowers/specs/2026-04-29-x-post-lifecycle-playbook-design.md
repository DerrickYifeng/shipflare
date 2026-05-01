# X Post Lifecycle Playbook — Design

**Date:** 2026-04-29
**Owner:** ShipFlare Dev
**Status:** Spec — pending implementation

## Problem

The post-writer agent drafts X posts using a single, phase-blind reference
guide (`x-content-guide.md`). It produces the same shape of content for a
founder on day 3 of building (`foundation`) as for one with $50K MRR three
years post-launch (`steady`). Empirical analysis of ~100 successful
build-in-public X accounts shows the post types, hook patterns, number
anchors, length targets, and banned moves change sharply across the product
lifecycle. The current writer ignores `plan_items.phase`, which has been
plumbed end-to-end since the strategic-paths refactor — the data is there,
the writer just doesn't read it.

The fix: teach the writer to read `phase` and follow a phase-specific
playbook, with a small voice-cluster vocabulary to cover stylistic variance
within a phase.

## Goals

- Per-phase content rules (hook patterns, number anchors, banned moves,
  length, templates) baked into `x-content-guide.md` and applied at draft
  time.
- A 5-cluster voice vocabulary so callers can override the phase default
  without inventing free-form descriptors.
- No DB schema changes. No new tools. No new validators. Prompt-only
  enforcement, backed by an upgrade from `claude-haiku-4-5-20251001` to
  `claude-sonnet-4-6` for the writer.
- X only in this iteration. Reddit lifecycle is a separate follow-up.

## Non-goals

- Adding a revenue / MRR field to `products` to differentiate Grok stages
  S4 / S5 / S6 (collapsed into `steady` with three sub-modes selected by
  caller hint).
- Validator-level enforcement of banned openers or vague-progress phrases
  (relies on the sonnet upgrade instead).
- Auto-detecting voice cluster from a founder's past posts.
- Reddit lifecycle support.
- Strategic / tactical planner changes — they continue to populate
  `plan_items.phase` exactly as today.

## Inputs

The lifecycle taxonomy comes from a structured analysis of ~100
build-in-public X accounts via Grok. The dataset documents per-stage post
types, hook patterns, banned phrases, length distributions, and verbatim
exemplars across 8 lifecycle stages (S0–S7). It is collapsed in this
design into ShipFlare's existing 6-phase taxonomy.

## Phase ↔ Grok-stage mapping

ShipFlare's `LaunchPhase` enum (`src/lib/launch-phase.ts`) is derived from
`products.state` + `launchDate` + `launchedAt`. The Grok S0–S7 lifecycle
maps onto it as follows:

| ShipFlare phase | Grok stages | Founder context |
|---|---|---|
| `foundation` | S0 + S1 + early S2 | No launch date set. Audience-build, idea validation, early MVP. |
| `audience` | mid-late S2 | 8–28 days to launch. MVP coming together, demand-building. |
| `momentum` | late S2 + pre-S3 | Final week. Hype, last-mile polish. |
| `launch` | S3 | Launch day or past launchDate but state still `launching`. |
| `compound` | S4 | First 30 days post-launch. First $0→$1K, first churn, first paying customer. |
| `steady` | S5 + S6 + S7 | 30+ days post-launch. Catch-all; sub-modes selected by hint. |

### Steady sub-modes

The `steady` phase carries three sub-modes the writer picks based on
caller-supplied hints in the spawn prompt:

- `steady.revenue_flex` — caller passes concrete revenue / user-count
  numbers. Writer uses revenue-update / annual-reflection templates
  (Grok S4-late + S5).
- `steady.contrarian_teacher` — default when no signal. Writer uses hot
  takes, "what I wish I knew at $0", systems & playbooks (Grok S6).
- `steady.sunset` — caller passes `sunsetting: true` or `pivoting: true`.
  Writer uses autopsy / pivot-rationale templates (Grok S7).

These live inside `x-content-guide.md` §5.6; no schema or tool change is
required to support them.

## Voice cluster vocabulary

Five clusters identified in the Grok dataset, mapped to recognisable
exemplars:

| Cluster | Exemplar style |
|---|---|
| `terse_shipper` | levelsio — minimal text, screenshots + numbers carry it. |
| `vulnerable_philosopher` | dvassallo — reflective one-liners with craft. |
| `daily_vlogger` | andrewzacker / tibo_maker — energetic Day-N cadence. |
| `patient_grinder` | ryanashcraft — sparse, grateful, milestone-only. |
| `contrarian_analyst` | marc_louvion — hot takes on the meta. |

### Voice defaults per phase (used when caller omits `voice` hint)

| Phase | Default voice |
|---|---|
| `foundation` | `daily_vlogger` |
| `audience` | `daily_vlogger` |
| `momentum` | `terse_shipper` |
| `launch` | `terse_shipper` |
| `compound` | `patient_grinder` |
| `steady` | `contrarian_analyst` |

Caller's `voice` hint (if any) wins. Free-form strings outside the
vocabulary are still accepted for back-compat — the writer maps them to
the closest cluster heuristically.

## Architecture

### What changes

| File | Change |
|---|---|
| `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md` | Restructured. Universal rules kept (lines 106–135 today), the rest replaced with voice clusters + 6-phase playbook + phase-aware bad/good examples. ~135 lines → ~600 lines. |
| `src/tools/AgentTool/agents/post-writer/AGENT.md` | (a) `model:` bumped from `claude-haiku-4-5-20251001` to `claude-sonnet-4-6`. (b) Workflow step 3 gains an instruction to read `phase` from `query_plan_items` and follow the matching playbook section. (c) `voice` soft hint gets a defined vocabulary. (d) `whyItWorks` enriched with the resolved phase + voice + template ID. |
| `src/tools/AgentTool/agents/post-writer/references/__tests__/x-content-guide.test.ts` | NEW — structural tests on the guide. |
| `src/tools/AgentTool/agents/post-writer/__tests__/AGENT.test.ts` | NEW or extended — pins `model: claude-sonnet-4-6`. |

### What does NOT change

- DB schema. No migration.
- `plan_items.phase` flow — already populated by the strategic and
  tactical planners.
- `query_plan_items` and `query_product_context` tools.
- `runContentValidators` pipeline (`length`, `platform_leak`,
  `hallucinated_stats` failures; `hashtag_count`, `links_in_reply`,
  `links_in_post_body`, `anchor_token` warnings).
- `validate_draft` tool, `repair-prompt` builder, `summarizeFailures`.
- The post-writer's self-check + rewrite-once + persist loop.
- `StructuredOutput` shape returned to the caller.
- `reddit-content-guide.md`, `content-safety.md`.
- Caller agents (`content-planner`, `coordinator`) — they already pass
  the plan_item row implicitly via `planItemId`; no new params needed.

### Data flow at draft time

```
content-planner / coordinator
        | spawns post-writer with planItemId
        v
post-writer (claude-sonnet-4-6)
        |  query_plan_items(id)        -> row including `phase`
        |  query_product_context()     -> name, description, valueProp
        |
        |  Reads x-content-guide.md (fully injected reference):
        |    - Universal rules (sec 1-3)
        |    - Voice clusters + phase defaults (sec 4)
        |    - Phase playbook (sec 5) — uses ONLY the subsection
        |      matching the row's `phase`
        |    - For phase=steady, picks sub-mode from caller hints
        |
        |  Drafts ONE tweet
        |  validate_draft()             unchanged
        |  draft_post()                  unchanged, with enriched whyItWorks
        v
plan_items.output updated, state -> 'drafted'
```

## `x-content-guide.md` structure

```
# X Content Guidelines

## 1. Output contract                              (~80 words; kept)
   - One single tweet <=280 weighted chars
   - Never \n\n-split into multiple tweets
   - Compression heuristics

## 2. Universal rules                              (~150 words; kept)
   2.1 Hard rules (validate_draft enforces):
       - 280 weighted chars
       - No links in body (use linkReply)
       - No sibling-platform leaks
       - No unsourced numeric claims
   2.2 Style targets (ShipFlare warnings):
       - #buildinpublic + 0-2 topical, hard cap 3
       - First person
       - Be specific
       - Avoid corporate vocabulary
       - No emoji overload
       - No product pitch in engagement content

## 3. Banned openers + begging phrases             (~80 words; NEW)
   Universal — bad in every phase. Soft enforced via prompt.
   Banned openers: "Excited to announce", "Excited to share",
                   "Big news!", "Quick update:", "Hey friends,",
                   "I'm thrilled to..."
   Banned begging: "please RT", "support means everything",
                   "any feedback appreciated", "RT if you like it"

## 4. Voice clusters                               (~250 words; NEW)
   Each cluster: 1-line description + 2 verbatim style markers +
                 when to use it.
   - terse_shipper            (levelsio-style)
   - vulnerable_philosopher    (dvassallo-style)
   - daily_vlogger             (andrewzacker / tibo_maker-style)
   - patient_grinder           (ryanashcraft-style)
   - contrarian_analyst        (marc_louvion-style)
   Default-voice-per-phase table (foundation -> daily_vlogger; etc.)
   Caller's voice hint overrides the default.

## 5. By-phase playbook                            (~2400 words; NEW)
   One subsection per phase, ~400 words each, using a fixed skeleton:
     - Default voice
     - Objective
     - Post types to use
     - Hook patterns to use
     - Number anchors
     - Length target
     - Phase-specific bans
     - Templates (2 per phase, with structure + verbatim example +
                  source post URL from the Grok dataset)

   5.1 foundation
   5.2 audience
   5.3 momentum
   5.4 launch
   5.5 compound
   5.6 steady           (~600 words — three sub-modes:
                          revenue_flex, contrarian_teacher, sunset)

## 6. Bad vs good examples                         (~300 words; expanded)
   - Existing multi-tweet vs single-tweet (kept)
   - NEW: phase-mismatch example (Day-N log written in steady)
   - NEW: banned-opener rewrite (Excited to share -> compressed alt)
```

**Source-of-truth principle:** templates use instructional shape only —
no third-party X account citations or verbatim quotes. The structure
itself (post types, hook patterns, number anchors, length, banned moves)
gives the writer enough to ground a draft. Where a labelled-synthetic
example helps (e.g. Template 5.4.B for first-revenue), it is included
inline and clearly marked as invented copy. We deliberately avoid baking
specific real founders' words into the system prompt — those accounts can
delete posts, change handles, or move on, and the guide should outlive
any single creator's career.

**Token budget:** ~600 lines / ~4K words / ~5K tokens for the guide.
Combined post-writer reference set lands ~12K tokens, well within
sonnet's working budget.

## `AGENT.md` diffs

### Frontmatter

```diff
-model: claude-haiku-4-5-20251001
+model: claude-sonnet-4-6
```

`maxTurns: 12` unchanged.

### Workflow step 3 — drafting

The "Draft the body" paragraph for X gains:

> Read `phase` from the plan_item row you just loaded — it is one of
> `foundation | audience | momentum | launch | compound | steady`. Open
> the matching subsection of x-content-guide §5 and apply the rules
> from THAT subsection: post types, hook patterns, number anchors,
> banned moves, length target, and the verbatim templates for that
> phase. Do NOT generalize across phases.
>
> For voice: if the caller's spawn prompt passed a `voice` hint (one
> of `terse_shipper | vulnerable_philosopher | daily_vlogger |
> patient_grinder | contrarian_analyst`), use it. Otherwise use the
> phase default from x-content-guide §4.
>
> For phase=steady: pick a sub-mode based on caller hints. Concrete
> revenue / user-count numbers in the spawn prompt → revenue_flex.
> `sunsetting` or `pivoting` flag → sunset. Otherwise →
> contrarian_teacher.

Reddit handling and compression heuristics in step 3 stay as-is.

### Soft-hints list

The existing `voice` hint line is replaced with:

> `voice` — voice cluster: one of `terse_shipper |
> vulnerable_philosopher | daily_vlogger | patient_grinder |
> contrarian_analyst`. Free-form strings still accepted but the
> cluster names map cleanly to x-content-guide §4. When omitted, the
> writer uses the phase default.

### `whyItWorks` enrichment

The writer's `draft_post({ planItemId, draftBody, whyItWorks })` call
includes the resolved phase, voice cluster, and template ID in
`whyItWorks`, e.g.:

> "compound-phase first-revenue update in patient_grinder voice, leads
> with $1,247 MRR per template 5.5.A"

Reviewers see exactly which playbook section produced each draft.

## Testing strategy

### Structural tests

| Test | File | Why |
|---|---|---|
| Guide contains all 6 phase sections with the required skeleton | `references/__tests__/x-content-guide.test.ts` (NEW) | Catches phase deletion / refactor regressions. |
| Guide defines all 5 voice clusters with unique names | same | Catches typos that would silently mismatch AGENT.md. |
| Phase default voice resolves to a defined cluster | same | Cross-references AGENT.md ↔ guide §4. |
| `steady` section contains all three sub-modes | same | Drift-prevention for the carve-out. |
| `AGENT.md model` field equals `claude-sonnet-4-6` | `__tests__/AGENT.test.ts` | Prevents accidental rollback to haiku. |
| Existing post-writer integration tests pass unchanged | `__tests__/**` | Smoke check that the contract didn't break. |

### Not tested

- LLM output quality — covered by manual smoke pass + production
  telemetry, not unit tests.
- Phase routing — `query_plan_items` already returns the row faithfully.
- Validator behavior — unchanged.

### Manual smoke pass (pre-merge)

Run the post-writer against one plan_item per phase (6 drafts, one for
each `LaunchPhase` value) and record the outputs in the PR description.
Watch for:

- `foundation` draft uses day-N or screenshot+caption hook.
- `compound` draft leads with a specific revenue number.
- `steady` draft picks the right sub-mode given the spawn prompt.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Sonnet drift over time silently degrades prompt-only enforcement. | Keep the manual-smoke checklist in the PR template; re-verify on every model bump. |
| Phase-mapping mismatch — a $5K-MRR founder and a $300K-MRR founder both land in `steady`. | Acceptable for v1; tracked under follow-up below. The three sub-modes inside `steady` cover the most useful split via caller hint. |
| Sonnet per-call cost is higher than haiku. | Writer typically uses 3–5 turns; dollar impact is modest, and the upgrade is what enables prompt-only enforcement. |

## Out of scope (follow-ups)

1. Reddit lifecycle playbook — needs its own data pull.
2. Validator-level anti-pattern enforcement (banned openers, begging).
3. Phase-aware `vague_progress` validator — would require plumbing
   `phase` into `runContentValidators`.
4. Per-phase reference injection (token savings don't justify the
   complexity at sonnet's context size).
5. Persisted voice preference on `products`.
6. `steady` revenue-tier sub-stages — needs a real MRR signal source.
7. Auto-detect voice from past posts.
8. Strategic / tactical planner passing `voice` in `plan_items.params`
   for campaign consistency.

## Acceptance

- [ ] `x-content-guide.md` restructured per the section above; templates
      use instructional shape (no third-party X URLs or verbatim quotes).
      Labelled-synthetic examples are acceptable where they aid concretion.
- [ ] `AGENT.md` model bumped, workflow step 3 updated, voice hint
      vocabulary defined, `whyItWorks` enrichment instructed.
- [ ] Structural guide tests pass.
- [ ] AGENT model pin test passes.
- [ ] Existing post-writer tests pass unchanged.
- [ ] Manual smoke pass: one draft per phase recorded in the PR.
