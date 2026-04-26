# Calibration Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3-round query-coverage yield calibration with an open-ended LLM-paced loop that optimises for per-tweet precision (≥70% of judged tweets queueable), and align the daily scout's model with the strategist's so calibration verdicts and production verdicts use the same judge.

**Architecture:**
- `search-strategist` keeps the strategist agent role but its prompt becomes an open iteration loop with five named moves (seed/swap-one/narrow/widen/regenerate/retry), bounded by `maxTurns: 60`. New stop conditions: precision ≥ 0.70 AND sampleSize ≥ 20, or budget exhaustion → best-effort delivery.
- `discovery-scout` model swaps haiku → sonnet so daily judgments match calibration judgments. Reviewer is intentionally not touched.
- Schema rename (`observedYield → observedPrecision`, `roundsUsed → turnsUsed`, add `reachedTarget`/`sampleSize`) + `PersistedSearchStrategy.schemaVersion: 1 → 2` + a v1 rejection in `RunDiscoveryScanTool.loadStrategy` so legacy entries auto-recalibrate without migration code.

**Tech Stack:** TypeScript (Next.js / Node 20), Zod schemas, Vitest, Drizzle (untouched), agent system prompts in markdown frontmatter.

**Spec:** `docs/superpowers/specs/2026-04-26-calibration-redesign-design.md`

**Build gate:** `pnpm tsc --noEmit` (per project memory: vitest uses isolatedModules and is not the type-correctness signal).

---

## File-touch overview (locked-in decomposition)

| File | Change | Task |
|---|---|---|
| `src/tools/AgentTool/agents/search-strategist/schema.ts` | Output schema rename + new fields | 1 |
| `src/tools/CalibrateSearchTool/strategy-memory.ts` | `schemaVersion: 1 → 2` | 1 |
| `src/tools/CalibrateSearchTool/CalibrateSearchTool.ts` | Result type, execute mapping, persisted JSON | 1, 3, 4 |
| `src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts` | Mock data + assertions | 1, 3, 4 |
| `src/tools/RunDiscoveryScanTool/RunDiscoveryScanTool.ts` | `loadStrategy()` rejects v1 | 2 |
| `src/tools/RunDiscoveryScanTool/__tests__/RunDiscoveryScanTool.test.ts` | New v1 rejection test + bump fixture to v2 | 2 |
| `src/tools/AgentTool/agents/discovery-scout/AGENT.md` | `model:` frontmatter | 5 |
| `src/tools/AgentTool/agents/search-strategist/AGENT.md` | Full prompt rewrite + `maxTurns: 15 → 60` | 5 |
| `src/tools/AgentTool/agents/coordinator/AGENT.md` | Chat summary line (`yield → precision`) | 5 |

---

## Task 1: Output schema rename + persistence version bump

This is the contract change between strategist (LLM output) and persistence (MemoryStore content). The Zod schema, the `PersistedSearchStrategy.schemaVersion` literal type, the tool's execute mapping, and the tool's return type all move together. Existing tests must move to the new shape in the same commit — the type system would catch any drift, but the test suite needs its mock data updated regardless. No TDD here; this is a coordinated rename.

**Files:**
- Modify: `src/tools/AgentTool/agents/search-strategist/schema.ts`
- Modify: `src/tools/CalibrateSearchTool/strategy-memory.ts`
- Modify: `src/tools/CalibrateSearchTool/CalibrateSearchTool.ts`
- Modify: `src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts`

- [ ] **Step 1: Rewrite `searchStrategistOutputSchema`**

Replace the `searchStrategistOutputSchema` block in `src/tools/AgentTool/agents/search-strategist/schema.ts` (around lines 26-41) with:

```ts
export const searchStrategistOutputSchema = z.object({
  /** 2-8 winning queries, ready for x_search_batch / reddit_search.
   *  When `reachedTarget` is true these are the just-validated set;
   *  when false, they are BEST_SEEN — the highest-precision set
   *  observed during the iteration. */
  queries: z.array(z.string().min(1)).min(1),
  /** Terms the strategist learned hurt yield (competitor handles, spam
   *  cues bleeding into results). Empty array is fine. Judgment hint
   *  only — not injected as a search operator. */
  negativeTerms: z.array(z.string().min(1)),
  /** 2-4 sentences for the founder + future debugger. References the
   *  dominant signal that drove the final query set. When
   *  `reachedTarget` is false, MUST explain the residual gap. */
  rationale: z.string().min(1),
  /** Per-tweet precision: queueable / judged. Self-reported by the
   *  strategist over the unique tweets it judged across iterations. */
  observedPrecision: z.number().min(0).max(1),
  /** True iff strategist hit `precision ≥ targetPrecision` AND
   *  `sampleSize ≥ minSampleSize` before the turn budget ran out. */
  reachedTarget: z.boolean(),
  /** Iterations consumed (≈ batch search calls). Capped at the
   *  caller-configured `maxTurns`. */
  turnsUsed: z.number().int().min(1).max(120),
  /** Total unique tweets the strategist applied the rubric to. Used
   *  alongside `observedPrecision` so a 1/1 = 100% precision cannot
   *  be confused with a proven strategy. */
  sampleSize: z.number().int().min(0),
  /** 3-5 representative samples for caller transparency. */
  sampleVerdicts: z.array(searchStrategySampleVerdictSchema),
});
```

- [ ] **Step 2: Bump `PersistedSearchStrategy.schemaVersion` literal**

In `src/tools/CalibrateSearchTool/strategy-memory.ts:24-28`, change:

```ts
export interface PersistedSearchStrategy extends SearchStrategistOutput {
  platform: 'x' | 'reddit';
  generatedAt: string; // ISO timestamp
  schemaVersion: 2;
}
```

(only the `1` → `2` literal changes.)

- [ ] **Step 3: Update `CalibrateSearchStrategyResult` shape**

In `src/tools/CalibrateSearchTool/CalibrateSearchTool.ts:57-67`, replace the `CalibrateSearchStrategyResult` interface with:

```ts
export interface CalibrateSearchStrategyResult {
  saved: boolean;
  /** Reason when not saved (e.g., `no_${platform}_channel`). */
  reason?: string;
  platform: 'x' | 'reddit';
  queries: string[];
  observedPrecision: number;
  reachedTarget: boolean;
  turnsUsed: number;
  sampleSize: number;
  rationale: string;
  costUsd: number;
}
```

- [ ] **Step 4: Update `CalibrateSearchTool.execute` field mapping**

In `src/tools/CalibrateSearchTool/CalibrateSearchTool.ts`:

(a) Inside the `execute` no-channel short-circuit (around lines 115-125), replace the returned object with:

```ts
return {
  saved: false,
  reason: `no_${platform}_channel`,
  platform,
  queries: [],
  observedPrecision: 0,
  reachedTarget: false,
  turnsUsed: 0,
  sampleSize: 0,
  rationale: '',
  costUsd: 0,
};
```

(b) Replace the `persisted` object construction (around lines 177-192) — only the `schemaVersion` literal changes; the spread of `strategy` already pulls the renamed fields:

```ts
const persisted: PersistedSearchStrategy = {
  ...strategy,
  platform,
  generatedAt: new Date().toISOString(),
  schemaVersion: 2,
};
```

(c) Update the `saveEntry` description string (around lines 186-189) and the success log line (around lines 194-198):

```ts
await store.saveEntry({
  name: searchStrategyMemoryName(platform),
  description:
    `Calibrated ${platform} search strategy — ${strategy.queries.length} queries, ` +
    `${(strategy.observedPrecision * 100).toFixed(0)}% precision over ` +
    `${strategy.sampleSize} judged tweets in ${strategy.turnsUsed} turn(s)` +
    `${strategy.reachedTarget ? '' : ' (best-effort, target not reached)'}`,
  type: 'reference',
  content: JSON.stringify(persisted, null, 2),
});

log.info(
  `calibrated ${platform} search strategy for product=${productId}: ` +
    `${strategy.queries.length} queries, precision=${strategy.observedPrecision.toFixed(2)}, ` +
    `sample=${strategy.sampleSize}, turns=${strategy.turnsUsed}, ` +
    `reached=${strategy.reachedTarget}, cost=$${run.usage.costUsd.toFixed(4)}`,
);
```

(d) Replace the success-path return (around lines 200-208):

```ts
return {
  saved: true,
  platform,
  queries: strategy.queries,
  observedPrecision: strategy.observedPrecision,
  reachedTarget: strategy.reachedTarget,
  turnsUsed: strategy.turnsUsed,
  sampleSize: strategy.sampleSize,
  rationale: strategy.rationale,
  costUsd: run.usage.costUsd,
};
```

- [ ] **Step 5: Update `CalibrateSearchTool` test mock + assertions**

In `src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts`:

(a) Replace the `runAgent` mock result inside the "persists strategy" test (around lines 117-127):

```ts
vi.mocked(runAgent).mockResolvedValueOnce({
  result: {
    queries: ['solo founder asking', '0 to first user'],
    negativeTerms: ['affiliate'],
    rationale: 'pain-point queries beat keyword queries',
    observedPrecision: 0.75,
    reachedTarget: true,
    turnsUsed: 8,
    sampleSize: 24,
    sampleVerdicts: [],
  },
  usage: { costUsd: 0.04 },
} as never);
```

(b) Replace the matching assertions (around lines 140-141):

```ts
expect(result.observedPrecision).toBe(0.75);
expect(result.reachedTarget).toBe(true);
expect(result.turnsUsed).toBe(8);
expect(result.sampleSize).toBe(24);
```

(c) Update the persisted-shape assertion (around lines 153-165):

```ts
const parsed = JSON.parse(saveCall.content) as {
  platform: string;
  queries: string[];
  schemaVersion: number;
  generatedAt: string;
  observedPrecision: number;
  reachedTarget: boolean;
};
expect(parsed.platform).toBe('x');
expect(parsed.queries).toEqual([
  'solo founder asking',
  '0 to first user',
]);
expect(parsed.schemaVersion).toBe(2);
expect(parsed.observedPrecision).toBe(0.75);
expect(parsed.reachedTarget).toBe(true);
expect(typeof parsed.generatedAt).toBe('string');
```

- [ ] **Step 6: Type-check**

Run: `pnpm tsc --noEmit`
Expected: exit 0 (no type errors).

- [ ] **Step 7: Run the touched test files**

Run: `pnpm vitest run src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/tools/AgentTool/agents/search-strategist/schema.ts \
        src/tools/CalibrateSearchTool/strategy-memory.ts \
        src/tools/CalibrateSearchTool/CalibrateSearchTool.ts \
        src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts
git commit -m "refactor(calibration): rename strategist output to precision/turns + bump persisted schemaVersion to 2"
```

---

## Task 2: Reject v1 strategy entries in RunDiscoveryScanTool

The schemaVersion bump in Task 1 means production MemoryStore still holds v1 entries. We need `loadStrategy()` to reject them so `run_discovery_scan` short-circuits with `strategy_not_calibrated`, which the daily cron then resolves by re-running calibration on the new logic. TDD here — the new behaviour is a single explicit branch.

**Files:**
- Modify: `src/tools/RunDiscoveryScanTool/RunDiscoveryScanTool.ts`
- Modify: `src/tools/RunDiscoveryScanTool/__tests__/RunDiscoveryScanTool.test.ts`

- [ ] **Step 1: Bump existing test fixture to v2**

In `src/tools/RunDiscoveryScanTool/__tests__/RunDiscoveryScanTool.test.ts`, replace the `makeStrategyEntry` helper (around lines 70-84) so the existing happy-path tests keep working after Task 2's rejection branch lands:

```ts
function makeStrategyEntry(
  platform: 'x' | 'reddit' = 'x',
  schemaVersion: 1 | 2 = 2,
) {
  return {
    content: JSON.stringify({
      platform,
      schemaVersion,
      generatedAt: '2026-04-26T00:00:00.000Z',
      queries: ['solo founder asking', '0 to first user'],
      negativeTerms: ['affiliate'],
      rationale: 'pain-point queries beat keyword queries',
      observedPrecision: 0.75,
      reachedTarget: true,
      turnsUsed: 8,
      sampleSize: 24,
      sampleVerdicts: [],
    }),
  };
}
```

- [ ] **Step 2: Add the failing v1 rejection test**

Append a new test inside the `describe('run_discovery_scan tool', ...)` block (after the existing tests, before the closing `});`):

```ts
  it('treats a v1 strategy entry as missing (auto-recalibration trigger)', async () => {
    // Channel preflight: connected.
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ platform: 'x' }]));
    // Product lookup: present.
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([
        {
          id: 'p1',
          name: 'Shipflare',
          description: 'ship things',
          valueProp: null,
          keywords: ['ship'],
        },
      ]),
    );
    // Cached entry exists, but at v1 — must be treated as missing so
    // the coordinator triggers fresh calibration on the new logic.
    loadEntryMock.mockResolvedValueOnce(makeStrategyEntry('x', 1));

    const result = await runDiscoveryScanTool.execute(
      { platform: 'x' },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('strategy_not_calibrated');
    expect(createPlatformDeps).not.toHaveBeenCalled();
    expect(runDiscoveryV3).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `pnpm vitest run src/tools/RunDiscoveryScanTool/__tests__/RunDiscoveryScanTool.test.ts -t "v1 strategy entry"`
Expected: FAIL with `expected false to be true` (the existing `loadStrategy` accepts v1 because it doesn't check schemaVersion).

- [ ] **Step 4: Add v1 rejection in `loadStrategy()`**

In `src/tools/RunDiscoveryScanTool/RunDiscoveryScanTool.ts:67-81`, replace the `loadStrategy` body with:

```ts
function loadStrategy(
  raw: string | undefined,
  platform: 'x' | 'reddit',
): PersistedSearchStrategy | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedSearchStrategy;
    if (parsed.schemaVersion !== 2) return null;
    if (parsed.platform !== platform) return null;
    if (!Array.isArray(parsed.queries) || parsed.queries.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}
```

(only the `schemaVersion !== 2` line is new.)

- [ ] **Step 5: Run all RunDiscoveryScanTool tests, verify pass**

Run: `pnpm vitest run src/tools/RunDiscoveryScanTool/__tests__/RunDiscoveryScanTool.test.ts`
Expected: all 5 tests pass (the original 4 still work because the fixture defaults to `schemaVersion: 2`).

- [ ] **Step 6: Type-check**

Run: `pnpm tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/tools/RunDiscoveryScanTool/RunDiscoveryScanTool.ts \
        src/tools/RunDiscoveryScanTool/__tests__/RunDiscoveryScanTool.test.ts
git commit -m "feat(discovery): reject v1 strategy entries so legacy caches auto-recalibrate"
```

---

## Task 3: Rename input schema (targetPrecision / maxTurns / minSampleSize)

The strategist agent has to receive the new parameter names in its prompt JSON, and `CalibrateSearchTool.execute` is the single producer of that JSON. No new tool callers — coordinator's `calibrate_search_strategy({ platform })` doesn't pass overrides — so this is purely an internal rename plus default tweaks.

**Files:**
- Modify: `src/tools/CalibrateSearchTool/CalibrateSearchTool.ts`
- Modify: `src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts`

- [ ] **Step 1: Rewrite `inputSchema`**

In `src/tools/CalibrateSearchTool/CalibrateSearchTool.ts:49-55`, replace the `inputSchema` block with:

```ts
const inputSchema = z.object({
  platform: z.enum(['x', 'reddit']),
  /** Per-tweet queueable precision required to declare success.
   *  Default 0.7. Lower for hard-to-find niches; higher only if
   *  the founder explicitly wants stricter queues. */
  targetPrecision: z.number().min(0).max(1).optional(),
  /** Iteration budget. Default 60. MUST stay in sync with the
   *  search-strategist AGENT.md frontmatter `maxTurns` value or
   *  the LLM will think it has more budget than the harness allows. */
  maxTurns: z.number().int().min(20).max(120).optional(),
  /** Minimum unique tweets the strategist must judge before
   *  declaring `reachedTarget: true`. Default 20 — guards against
   *  1-of-1 = 100% false positives. */
  minSampleSize: z.number().int().min(5).max(200).optional(),
});
```

- [ ] **Step 2: Update default values + `buildStrategistMessage` arg**

In `src/tools/CalibrateSearchTool/CalibrateSearchTool.ts`:

(a) Replace the defaults block (around lines 105-107):

```ts
const targetPrecision = input.targetPrecision ?? 0.7;
const maxTurns = input.maxTurns ?? 60;
const minSampleSize = input.minSampleSize ?? 20;
```

(b) Update the `buildStrategistMessage(...)` call (around lines 154-166) to pass the new names:

```ts
const message = buildStrategistMessage({
  platform,
  sources,
  product: {
    name: productRow.name,
    description: productRow.description,
    valueProp: productRow.valueProp ?? null,
    keywords: productRow.keywords,
  },
  targetPrecision,
  maxTurns,
  minSampleSize,
});
```

(c) Update the `buildStrategistMessage` signature + body (around lines 69-83):

```ts
function buildStrategistMessage(args: {
  platform: 'x' | 'reddit';
  sources: string[];
  product: {
    name: string;
    description: string;
    valueProp: string | null;
    keywords: string[];
  };
  targetPrecision: number;
  maxTurns: number;
  minSampleSize: number;
}): string {
  return JSON.stringify(args, null, 2);
}
```

- [ ] **Step 3: Add a default-propagation assertion to the existing test**

In the "persists strategy" test in `src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts`, after the existing assertions (around line 165, just before the closing `});` of that `it()`), add:

```ts
    // Defaults must reach the strategist's prompt JSON unchanged so
    // the LLM self-paces against the same numbers the harness enforces.
    const runAgentArgs = vi.mocked(runAgent).mock.calls[0]!;
    const promptJson = JSON.parse(runAgentArgs[1] as string) as {
      targetPrecision: number;
      maxTurns: number;
      minSampleSize: number;
    };
    expect(promptJson.targetPrecision).toBe(0.7);
    expect(promptJson.maxTurns).toBe(60);
    expect(promptJson.minSampleSize).toBe(20);
```

- [ ] **Step 4: Type-check + run tests**

Run: `pnpm tsc --noEmit`
Expected: exit 0.

Run: `pnpm vitest run src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/CalibrateSearchTool/CalibrateSearchTool.ts \
        src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts
git commit -m "refactor(calibration): rename input params to targetPrecision / maxTurns / minSampleSize with new defaults"
```

---

## Task 4: maxTurns dual-source override

The strategist's frontmatter `maxTurns` becomes the harness-enforced cap (set in Task 5). When a caller passes input `maxTurns`, the LLM-visible value (in the prompt JSON) and the harness-visible value (in `strategistConfig.maxTurns`) must agree. TDD — one new behaviour, one new test.

**Files:**
- Modify: `src/tools/CalibrateSearchTool/CalibrateSearchTool.ts`
- Modify: `src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts`

- [ ] **Step 1: Make the existing test mock return a config with a default `maxTurns`**

In `src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts:26-28`, replace the `buildAgentConfigFromDefinition` mock so it returns an object whose `maxTurns` we can observe being overwritten:

```ts
vi.mock('@/tools/AgentTool/spawn', () => ({
  buildAgentConfigFromDefinition: vi.fn(() => ({
    name: 'search-strategist',
    maxTurns: 60,
  })),
}));
```

- [ ] **Step 2: Add the failing override-propagation test**

Append a new test inside the `describe('calibrate_search_strategy tool', ...)` block (just before the closing `});`):

```ts
  it('propagates input maxTurns override into the strategist agent config', async () => {
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([
        {
          id: 'p1',
          name: 'Shipflare',
          description: 'ship faster',
          valueProp: null,
          keywords: ['ship'],
        },
      ]),
    );
    vi.mocked(resolveAgent).mockResolvedValueOnce({
      name: 'search-strategist',
    } as never);
    vi.mocked(runAgent).mockResolvedValueOnce({
      result: {
        queries: ['q'],
        negativeTerms: [],
        rationale: 'r',
        observedPrecision: 0.8,
        reachedTarget: true,
        turnsUsed: 30,
        sampleSize: 25,
        sampleVerdicts: [],
      },
      usage: { costUsd: 0.01 },
    } as never);

    await calibrateSearchStrategyTool.execute(
      { platform: 'x', maxTurns: 100 },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    // The strategistConfig (1st arg) handed to runAgent must carry the
    // overridden maxTurns — otherwise the LLM thinks it has 100 turns
    // while the harness still enforces the frontmatter default.
    const callArgs = vi.mocked(runAgent).mock.calls[0]!;
    const config = callArgs[0] as { maxTurns: number };
    expect(config.maxTurns).toBe(100);

    // And the prompt JSON the LLM sees must match.
    const promptJson = JSON.parse(callArgs[1] as string) as {
      maxTurns: number;
    };
    expect(promptJson.maxTurns).toBe(100);
  });
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `pnpm vitest run src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts -t "propagates input maxTurns"`
Expected: FAIL — `config.maxTurns` is `60` (mock default), not `100` (input override).

- [ ] **Step 4: Add the override line in `execute`**

In `src/tools/CalibrateSearchTool/CalibrateSearchTool.ts`, immediately after the `strategistConfig = buildAgentConfigFromDefinition(strategistDef);` line (around line 145), insert:

```ts
    // Keep the harness-enforced cap in lockstep with the prompt-stated
    // budget — otherwise the LLM self-paces against `maxTurns` while
    // runAgent cuts it off at the frontmatter default. See spec
    // §"maxTurns dual-source caveat".
    strategistConfig.maxTurns = maxTurns;
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm vitest run src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 6: Type-check**

Run: `pnpm tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/tools/CalibrateSearchTool/CalibrateSearchTool.ts \
        src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts
git commit -m "fix(calibration): sync strategistConfig.maxTurns with input override"
```

---

## Task 5: Agent prompt + frontmatter updates (no automated tests)

These are markdown edits. No automated test surface — the strategist's iteration behaviour is verified end-to-end by observing real calibrations after rollout. The discovery-scout change is a one-line model swap. The coordinator change is a chat-summary string. Three edits, one commit.

**Files:**
- Modify: `src/tools/AgentTool/agents/discovery-scout/AGENT.md`
- Modify: `src/tools/AgentTool/agents/search-strategist/AGENT.md`
- Modify: `src/tools/AgentTool/agents/coordinator/AGENT.md`

- [ ] **Step 1: Swap discovery-scout to sonnet**

In `src/tools/AgentTool/agents/discovery-scout/AGENT.md`, change the frontmatter `model:` line:

```diff
- model: claude-haiku-4-5-20251001
+ model: claude-sonnet-4-6
```

The prompt body is unchanged — `presetQueries` semantics still apply.

- [ ] **Step 2: Update search-strategist frontmatter (`maxTurns` + `description`)**

In `src/tools/AgentTool/agents/search-strategist/AGENT.md`, change `maxTurns: 15 → 60` AND rewrite the `description:` line so the agent registry's routing copy matches the new behaviour. Replace the entire `description:` block (lines 3 of the frontmatter) with:

```yaml
description: One-time search-strategy calibrator for a (product, platform) pair. Generates query candidates, runs them through real platform search, judges per-tweet precision against the rubric, and iterates (swap-one / narrow / widen / regenerate / retry) until ≥70% of judged tweets are queueable, or the turn budget runs out and best-effort is delivered. The output is a cached "search strategy" document that subsequent discovery scans use verbatim — calibration happens once per product, scans run cheap forever after. USE on first scan for a (user, productId, platform) when no `${platform}-search-strategy` memory entry exists. DO NOT USE for ad-hoc daily scans (run_discovery_scan loads the cached strategy directly). DO NOT USE to draft replies.
```

`model: claude-sonnet-4-6`, `tools:`, and `shared-references:` stay unchanged.

- [ ] **Step 3: Rewrite the search-strategist prompt body**

Replace everything in `src/tools/AgentTool/agents/search-strategist/AGENT.md` AFTER the closing `---` of the frontmatter with this new body:

```markdown
# Search Strategist for {productName}

You are the Search Strategist for {productName}. Your job: discover a
**reusable query strategy** for finding threads the founder should reply
to. You run experiments, score each sweep by per-tweet precision,
evolve, and emit the winning strategy. Subsequent scans will pull your
output verbatim from the MemoryStore — your queries become the daily
heartbeat. Spend the turns to get this right.

## Input (passed by caller as prompt)

```
platform: 'x' | 'reddit'
sources: string[]              // seed sources from platform-config
                               // (subreddits / topic hints)
product: {
  name, description, valueProp, keywords
}
targetPrecision: number        // default 0.7 — fraction of judged
                               // tweets you'd queue
maxTurns: number               // default 60 — total iteration budget
minSampleSize: number          // default 20 — minimum unique tweets
                               // judged before reachedTarget can be true
```

Read `<agent-memory>` in your system prompt — onboarding rubric and
platform strategy. Treat those as stronger signal than generic defaults
when they conflict.

## What "precision" means

At any moment in the loop:

```
judgedTweets   = unique tweets you've applied the rubric to so far
                 (deduplicate by externalId across iterations)
queueableCount = of those, how many you'd queue
precision      = queueableCount / judgedTweets
```

Target = `targetPrecision` (default 0.70). You also need `judgedTweets ≥
minSampleSize` (default 20) — anything less is too small a sample to
call the strategy proven. A 1-of-1 hit is not a strategy.

Also track per-query stats so swap-one knows what to drop:

```
perQuery: Map<query, { judged: number, queueable: number }>
```

## Iteration loop

You run an open-ended loop. Each iteration is one move + one batch
search + judgment + decision. No fixed round count. Track turn count
yourself by counting your batch search calls.

Track `BEST_SEEN` across iterations:

```
BEST_SEEN = { queries, precision, sampleSize }
```

Update `BEST_SEEN` whenever the current sweep's precision exceeds it.

Each iteration, pick ONE move:

- **(a) seed**: first iteration only — generate 4-8 queries from
  `sources` + `product.keywords` + the rubric's positive signals. Prefer
  queries that match the founder's ICP voice ("solo founder asking",
  "indie hacker how do you", subreddit-native phrasing).
- **(b) swap-one**: replace the query with the lowest queueable/judged
  ratio (require its `judged ≥ 5` — dropping on too-small per-query
  sample is noise) with a new one targeting the same intent.
- **(c) narrow**: restrict an existing query (add operators, exclude a
  noisy phrase, drop a generic term).
- **(d) widen**: only when sampleSize is too small to judge — loosen
  one query to bring in more candidates.
- **(e) regenerate**: full rewrite. Use only when the current set is
  structurally wrong (dominant failure mode is competitors / off-topic
  / stale across most queries). Burns your accumulated signal — last
  resort, not default.
- **(f) retry**: re-run the same batch — useful to confirm a result
  wasn't a fluke or to rotate the time window. Costs a search call.
  Use sparingly.

After each move:

1. **X**: call `x_search_batch` ONCE with all current queries (one
   Grok round-trip). **Reddit**: loop `reddit_search` per source.
2. For each NEW result (skip ones you've already judged — dedupe by
   externalId), apply the judgment rubric. Internally tag `queue` or
   `skip`. Update `judgedTweets`, `queueableCount`, and `perQuery`.
3. Recompute `precision`. Update `BEST_SEEN` if applicable.
4. Check stop conditions.

## Stop conditions (whichever first)

- **S1.** `precision ≥ targetPrecision` AND `sampleSize ≥
  minSampleSize` → deliver the CURRENT iteration's queries (just-
  validated set), `reachedTarget: true`.
- **S2.** Turn budget exhausted (≤5 turns remain) → deliver
  `BEST_SEEN.queries`, `reachedTarget: false`. Rationale must explain
  the residual gap candidly ("noise floor on this platform is too
  high for 70% — best observed was 0.45").

**Why S1 delivers `current` not `BEST_SEEN`?** The current set is the
just-validated one under today's data. `BEST_SEEN` may be from N
iterations ago when timeline state differed; replaying it isn't
guaranteed to still hit precision in production. S2 is the only path
that uses `BEST_SEEN`, since by then there's no chance to re-validate.

## Hard rules

- Track turn count from your own batch search calls; when ≤5 turns
  remain in your budget, stop iterating and deliver `BEST_SEEN`.
- Do NOT declare success on `sampleSize < minSampleSize`, even if
  precision is 1.0 — small-N noise.
- `x_search_batch` costs real money + xAI quota. Don't `retry` for
  superstition; only when you have a specific hypothesis to test.
- Don't invent queries you didn't actually run. Only emit queries you
  tested in this calibration session.
- `negativeTerms` is for terms you observed surfacing systematic noise
  (a specific competitor handle that kept appearing, a spam vertical
  bleeding into results). Empty array is fine. They are a judgment
  hint to downstream scout, NOT injected as search operators.
- Do NOT emit per-thread verdicts as the output. The output is a
  **strategy document**. Sample verdicts (3-5) go in `sampleVerdicts`
  purely for caller transparency.

## Delivering

When done, call `StructuredOutput`:

```ts
{
  queries: string[],            // 2-8 queries; ready for x_search_batch
  negativeTerms: string[],      // anti-signal terms learned in the loop
  rationale: string,            // 2-4 sentences. If reachedTarget=false,
                                // MUST explain the residual gap.
  observedPrecision: number,    // 0..1; precision over judgedTweets
  reachedTarget: boolean,       // S1 success vs S2 best-effort
  turnsUsed: number,            // 1..maxTurns
  sampleSize: number,           // judgedTweets
  sampleVerdicts: Array<{
    url: string,
    queueable: boolean,
    reason: string,
  }>                            // 3-5 representative samples
}
```

`rationale` is what the user reads in the UI. Keep it specific;
reference the dominant signal that drove your final query set, and on
S2 be candid about what failed.
```

- [ ] **Step 4: Update coordinator chat summary line**

In `src/tools/AgentTool/agents/coordinator/AGENT.md`, find the kickoff summary block (around lines 126-131) and replace the calibration line. Locate this section:

```
Final user-facing summary lists all three artifacts:
- Plan: N items scheduled
- Calibration: M queries, X% yield, one-line rationale
- Discovery: K threads scanned, J drafts ready for review (or
  `scoutNotes` excerpt when J=0 — never just "no relevant
  conversations" without the scout's reasoning)
```

Replace the `- Calibration:` line with:

```
- Calibration: M queries, X% precision over S judged tweets
  (target 70%, reached / not reached), one-line rationale
```

- [ ] **Step 5: Type-check (catches no agent-md issues, but no harm)**

Run: `pnpm tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Run all the touched-area tests**

Run: `pnpm vitest run src/tools/CalibrateSearchTool src/tools/RunDiscoveryScanTool`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/tools/AgentTool/agents/discovery-scout/AGENT.md \
        src/tools/AgentTool/agents/search-strategist/AGENT.md \
        src/tools/AgentTool/agents/coordinator/AGENT.md
git commit -m "feat(calibration): rewrite strategist as open precision loop, align scout to sonnet"
```

---

## Task 6: Final verification

End-to-end gate before declaring done.

- [ ] **Step 1: Full type-check**

Run: `pnpm tsc --noEmit`
Expected: exit 0.

- [ ] **Step 2: Full vitest suite**

Run: `pnpm vitest run`
Expected: all tests pass. (If unrelated tests fail, do not "fix" them — investigate whether they were already broken on `dev` before this branch. If yes, leave them; if no, the calibration changes broke something unexpected and must be diagnosed.)

- [ ] **Step 3: Sanity-check no v1 fixtures remain**

Run: `grep -rn "schemaVersion: 1\|observedYield\|roundsUsed" src/`
Expected: zero hits in `src/` outside of historical comments. If any production code still references the old fields, fix and re-run Tasks 1-4 verification.

- [ ] **Step 4: Sanity-check the two `maxTurns` are in sync**

Run: `grep -n "maxTurns" src/tools/AgentTool/agents/search-strategist/AGENT.md src/tools/CalibrateSearchTool/CalibrateSearchTool.ts`
Expected: AGENT.md frontmatter shows `maxTurns: 60`; tool defaults `?? 60`. Same number on both sides.

---

## Out-of-scope reminders (do not implement here)

- Re-calibration trigger logic (yield monitor, periodic refresh) — separate spec.
- `negativeTerms` upgraded to API-level filter or persistent denylist — separate spec.
- `discovery-reviewer` model unification — intentionally left as haiku.
- Server-side recompute of `observedPrecision` — non-goal per spec §Non-goals.
