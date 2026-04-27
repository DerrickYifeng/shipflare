# Kickoff Fast Path & Generic Tool-Progress Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder kickoff playbook so `/today` shows post + reply drafts within ~1 minute of onboarding (calibration runs in background); ship a generic `tool_progress` event channel so any slow tool can surface log-style progress through one mechanism.

**Architecture:** Three layers of change. (1) Foundation: `ToolContext.emitProgress` + `publishToolProgress` Redis publisher routed via existing `publishUserEvent('agents', ...)`. (2) Tool / agent layer: `run_discovery_scan` accepts `inlineQueryCount` and runs scout-inline when no strategy exists (the `strategy_not_calibrated` skip branch is **deleted**, not deprecated); `calibrate_search_strategy` injects a `report_progress` tool into the strategist's toolset bound to the calibrate tool's identity. (3) Orchestration + UI: coordinator playbook reorders to `1 → 3 → 4 → 2 → 3'` with a 0-result fallback; `TacticalProgressCard` consumes `tool_progress` events and routes by `toolName` to bespoke sections, falling through to a generic activity ticker for unknown tools.

**Tech Stack:** TypeScript, Next.js 15 App Router, Zod, Vitest, IORedis pub/sub, Anthropic SDK (via the in-house `runAgent`/`query-loop` harness), React 19, SWR.

**Reference spec:** `docs/superpowers/specs/2026-04-26-kickoff-fast-path-and-tool-progress-design.md`

**Backwards compatibility:** None. Per project rule: deletes old behavior rather than gating it. The `strategy_not_calibrated` skip branch, the `CalibrationView.maxRounds` field, the `discovery_cron`'s "if skipped: strategy_not_calibrated → calibrate then re-scan" branch, and any tests asserting the deleted branches are removed outright.

---

## Phase 1 — Tool-progress foundation

### Task 1: Add `publishToolProgress` helper + tests

**Files:**
- Create: `src/lib/sse/publish-tool-progress.ts`
- Create: `src/lib/sse/__tests__/publish-tool-progress.test.ts`

**Context:** The existing `publishUserEvent(userId, channel, data)` in `src/lib/redis/index.ts` is the SSE publisher. The `agents` channel already carries calibration / draft / agent lifecycle events. We add a typed wrapper that emits a `tool_progress` event into that channel and is the only call site domain code uses for progress.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/sse/__tests__/publish-tool-progress.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const publishUserEventMock = vi.fn();
vi.mock('@/lib/redis', () => ({
  publishUserEvent: (...args: unknown[]) => publishUserEventMock(...args),
}));

const loggerWarnMock = vi.fn();
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
  }),
}));

import {
  publishToolProgress,
  __resetDroppedCounter,
  __getDroppedCount,
} from '../publish-tool-progress';

describe('publishToolProgress', () => {
  beforeEach(() => {
    publishUserEventMock.mockReset();
    loggerWarnMock.mockReset();
    __resetDroppedCounter();
  });

  it('publishes a tool_progress event into the agents channel', async () => {
    publishUserEventMock.mockResolvedValueOnce(undefined);

    await publishToolProgress({
      userId: 'u1',
      toolName: 'calibrate_search_strategy',
      message: 'Round 12/60 · precision 0.58',
      metadata: { round: 12, maxTurns: 60, precision: 0.58 },
    });

    expect(publishUserEventMock).toHaveBeenCalledTimes(1);
    const [userId, channel, payload] = publishUserEventMock.mock.calls[0]!;
    expect(userId).toBe('u1');
    expect(channel).toBe('agents');
    expect(payload).toMatchObject({
      type: 'tool_progress',
      toolName: 'calibrate_search_strategy',
      message: 'Round 12/60 · precision 0.58',
      metadata: { round: 12, maxTurns: 60, precision: 0.58 },
    });
    expect(typeof payload.callId).toBe('string');
    expect(payload.callId.length).toBeGreaterThan(0);
    expect(typeof payload.ts).toBe('number');
  });

  it('does not throw and increments dropped counter when publish fails', async () => {
    publishUserEventMock.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      publishToolProgress({
        userId: 'u1',
        toolName: 'run_discovery_scan',
        message: 'Searching X with 12 queries',
      }),
    ).resolves.toBeUndefined();

    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    expect(__getDroppedCount()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/sse/__tests__/publish-tool-progress.test.ts`

Expected: FAIL with module-not-found on `'../publish-tool-progress'`.

- [ ] **Step 3: Implement the helper**

```ts
// src/lib/sse/publish-tool-progress.ts
/**
 * publishToolProgress — single emit point for live "tool is doing X" updates.
 *
 * Wraps `publishUserEvent(userId, 'agents', ...)` in a typed `tool_progress`
 * envelope so the /today TacticalProgressCard can route by `toolName` to the
 * right UI section. UI decoration only — failures are caught, counted, and
 * logged but **never thrown**: a Redis hiccup must not crash the agent loop.
 */

import { randomUUID } from 'node:crypto';
import { publishUserEvent } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:sse:tool-progress');

export interface ToolProgressEvent {
  type: 'tool_progress';
  toolName: string;
  callId: string;
  message: string;
  metadata?: Record<string, unknown>;
  ts: number;
}

export interface PublishToolProgressArgs {
  userId: string;
  toolName: string;
  message: string;
  metadata?: Record<string, unknown>;
}

let droppedCount = 0;

export async function publishToolProgress(
  args: PublishToolProgressArgs,
): Promise<void> {
  const event: ToolProgressEvent = {
    type: 'tool_progress',
    toolName: args.toolName,
    callId: randomUUID(),
    message: args.message,
    ...(args.metadata ? { metadata: args.metadata } : {}),
    ts: Date.now(),
  };
  try {
    await publishUserEvent(
      args.userId,
      'agents',
      event as unknown as Record<string, unknown>,
    );
  } catch (err) {
    droppedCount += 1;
    log.warn(
      `dropped tool_progress event tool=${args.toolName} user=${args.userId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Test-only — reset the in-process dropped counter. */
export function __resetDroppedCounter(): void {
  droppedCount = 0;
}

/** Test-only / observability — current dropped count. */
export function __getDroppedCount(): number {
  return droppedCount;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/sse/__tests__/publish-tool-progress.test.ts`

Expected: PASS — both cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sse/publish-tool-progress.ts src/lib/sse/__tests__/publish-tool-progress.test.ts
git commit -m "feat(sse): add publishToolProgress helper for tool_progress events"
```

---

### Task 2: Add `emitProgress` to `ToolContext` + thread it through `createToolContext`

**Files:**
- Modify: `src/core/types.ts:45-48`
- Modify: `src/core/query-loop.ts:854-868`

**Context:** The single shared `ToolContext` lives at `src/core/types.ts:45`. `createToolContext` in `src/core/query-loop.ts:854` is the only constructor — every tool dispatch path (top-level agent, sub-agent run, tests) builds via it. Adding `emitProgress` here covers all call sites without per-site rewrites. The signature passes `toolName` explicitly because tools know their own name and sub-agents need to attribute progress to the *outer* tool that spawned them (more on this in Task 5/6).

- [ ] **Step 1: Modify `ToolContext` to include `emitProgress`**

```ts
// src/core/types.ts — replace the existing ToolContext interface (lines 45-48)
export interface ToolContext {
  abortSignal: AbortSignal;
  /**
   * Emit a live progress update for a slow tool. Optional — tools that
   * are fast enough not to need a status line just don't call it.
   *
   * `toolName` is passed explicitly so a sub-agent's report_progress
   * tool can attribute progress to the *outer* tool that spawned it
   * (e.g. the strategist running inside `calibrate_search_strategy`
   * passes `toolName: 'calibrate_search_strategy'`, not its own
   * sub-agent identifier). The transport (publishToolProgress) takes
   * care of userId binding and Redis fan-out; failures inside
   * `emitProgress` MUST NOT throw.
   */
  emitProgress?: (
    toolName: string,
    message: string,
    metadata?: Record<string, unknown>,
  ) => void;
  get<T>(key: string): T;
}
```

- [ ] **Step 2: Extend `createToolContext` signature**

```ts
// src/core/query-loop.ts — replace the existing createToolContext (lines 854-868)
export function createToolContext(
  deps: Record<string, unknown>,
  abortSignal?: AbortSignal,
  emitProgress?: ToolContext['emitProgress'],
): ToolContext {
  return {
    abortSignal: abortSignal ?? new AbortController().signal,
    ...(emitProgress ? { emitProgress } : {}),
    get<T>(key: string): T {
      const value = deps[key];
      if (value === undefined) {
        throw new Error(`Missing dependency: ${key}`);
      }
      return value as T;
    },
  };
}
```

- [ ] **Step 3: Run the type check**

Run: `pnpm tsc --noEmit --pretty false 2>&1 | head -40`

Expected: clean. Existing `createToolContext(deps, signal)` call sites remain valid because `emitProgress` is optional.

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts src/core/query-loop.ts
git commit -m "feat(core): add ToolContext.emitProgress for tool_progress events"
```

---

### Task 3: Wire top-level `emitProgress` into the team-run agent dispatcher

**Files:**
- Modify: `src/bridge/agent-runner.ts` (re-exports + glue)
- Find + modify: the team-run worker's `runAgent` call site that builds the coordinator's ctx

**Context:** Top-level agent runs are kicked off by the team-run worker when it picks up a `team_runs` row from BullMQ. That worker pulls `userId`, builds the coordinator's `ctx`, then calls `runAgent(coordinatorConfig, goal, ctx, schema)`. The team-run worker is the only place that natively knows `userId` *before* any tool dispatch, so it's where we bind `emitProgress`.

- [ ] **Step 1: Locate the team-run worker's coordinator dispatch**

```bash
grep -rn "runAgent.*coordinatorConfig\|runAgent.*coordinator" src/workers src/lib/queue 2>/dev/null
```

Expected: one or two hits in `src/workers/processors/` (team-run processor). Open the file (likely `src/workers/processors/team-run.ts` or similar).

- [ ] **Step 2: Add the binding**

In the team-run processor where `createToolContext(deps, signal)` (or equivalent) is called for the coordinator, change to:

```ts
import { publishToolProgress } from '@/lib/sse/publish-tool-progress';
// ...

const ctx = createToolContext(
  deps,
  abortSignal,
  (toolName, message, metadata) => {
    // Fire-and-forget; publishToolProgress already swallows errors.
    void publishToolProgress({ userId, toolName, message, metadata });
  },
);
```

- [ ] **Step 3: Verify build**

Run: `pnpm tsc --noEmit --pretty false 2>&1 | head -40`

Expected: clean.

- [ ] **Step 4: Commit**

Replace `<found-path>` below with the actual file path you located in step 1.

```bash
git add <found-path>
git commit -m "feat(team-run): bind emitProgress on the coordinator ToolContext"
```

---

## Phase 2 — Tool layer changes

### Task 4: Thread `inlineQueryCount` through `v3-pipeline`

**Files:**
- Modify: `src/lib/discovery/v3-pipeline.ts` (`V3PipelineInput`, `buildScoutMessage`)
- Modify: `src/lib/discovery/__tests__/` (if a v3-pipeline test exists; otherwise no test change here — the surface is exercised end-to-end via Task 5's tests)

**Context:** `runDiscoveryV3` is the pure orchestrator that scout calls. It already accepts `presetQueries?: string[]`. We add `inlineQueryCount?: number` alongside it and pass it through to the scout message JSON so the scout AGENT.md (Task 7) can branch on it.

- [ ] **Step 1: Add `inlineQueryCount` to `V3PipelineInput`**

In `src/lib/discovery/v3-pipeline.ts`, in the `V3PipelineInput` interface (around line 45-69), add a new field below `negativeTerms`:

```ts
  /**
   * When `presetQueries` is empty/undefined, scout falls back to
   * inline query generation. `inlineQueryCount` (default 8) tells
   * scout how many queries to produce. Pass `12` from the kickoff
   * fast-path scan so scout deliberately spans breadth (broad +
   * medium + specific). Cron / subsequent scans omit this and let
   * scout's default kick in.
   */
  inlineQueryCount?: number;
```

- [ ] **Step 2: Pass it through `buildScoutMessage`**

Replace `buildScoutMessage` (around line 111-128):

```ts
function buildScoutMessage(input: V3PipelineInput, coldStart: boolean): string {
  return JSON.stringify(
    {
      platform: input.platform,
      sources: input.sources,
      product: input.product,
      intent: input.intent ?? null,
      coldStart,
      presetQueries: input.presetQueries ?? null,
      negativeTerms: input.negativeTerms ?? null,
      inlineQueryCount: input.inlineQueryCount ?? null,
    },
    null,
    2,
  );
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm tsc --noEmit --pretty false 2>&1 | head -40`

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/discovery/v3-pipeline.ts
git commit -m "feat(discovery): plumb inlineQueryCount through v3-pipeline"
```

---

### Task 5: `RunDiscoveryScanTool` — accept `inlineQueryCount`, delete `strategy_not_calibrated` skip, emit progress

**Files:**
- Modify: `src/tools/RunDiscoveryScanTool/RunDiscoveryScanTool.ts`
- Modify: `src/tools/RunDiscoveryScanTool/__tests__/RunDiscoveryScanTool.test.ts` (delete two cases, add three)

**Context:** Today the tool short-circuits with `skipped: true, reason: 'strategy_not_calibrated'` when the MemoryStore entry is missing. Per the spec we **delete that branch** so absence-of-strategy becomes a normal inline-mode scan. We also accept `inlineQueryCount` and forward it to the pipeline. Tests for the deleted branch are removed (not adapted).

- [ ] **Step 1: Update the failing tests first (TDD)**

Replace the contents of `src/tools/RunDiscoveryScanTool/__tests__/RunDiscoveryScanTool.test.ts` from line 91 (`describe('run_discovery_scan tool', () => {`) onward with the version below. The deleted tests are: `'returns skipped:strategy_not_calibrated when MemoryStore has no strategy'` and `'treats a v1 strategy entry as missing (auto-recalibration trigger)'`. The new tests cover the inline branch and the progress emit.

```ts
describe('run_discovery_scan tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockReset();
    loadEntryMock.mockReset();
  });

  it('returns skipped:true when user has no channel for the platform', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([]));

    const result = await runDiscoveryScanTool.execute(
      { platform: 'x' },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_x_channel');
    expect(result.queued).toHaveLength(0);
  });

  it('falls back to scout-inline mode when MemoryStore has no strategy', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ platform: 'x' }]));
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
    dbSelectMock.mockReturnValue(buildSelectChain([]));

    loadEntryMock.mockResolvedValueOnce(null);
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);
    vi.mocked(runDiscoveryV3).mockResolvedValueOnce({
      verdicts: [],
      review: { ran: false, decision: { mode: 'skip' }, disagreements: null },
      scoutNotes: 'inline scan ran',
      usage: { scout: { costUsd: 0.01 }, reviewer: null },
      rubricGenerated: false,
    } as never);

    const result = await runDiscoveryScanTool.execute(
      { platform: 'x', inlineQueryCount: 12 },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.skipped).toBe(false);
    const callArg = vi.mocked(runDiscoveryV3).mock.calls[0]![0];
    expect(callArg.presetQueries).toBeUndefined();
    expect(callArg.negativeTerms).toBeUndefined();
    expect(callArg.inlineQueryCount).toBe(12);
  });

  it('treats a v1 strategy entry as missing (auto-recalibration trigger)', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ platform: 'x' }]));
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
    dbSelectMock.mockReturnValue(buildSelectChain([]));

    loadEntryMock.mockResolvedValueOnce(makeStrategyEntry('x', 1));
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);
    vi.mocked(runDiscoveryV3).mockResolvedValueOnce({
      verdicts: [],
      review: { ran: false, decision: { mode: 'skip' }, disagreements: null },
      scoutNotes: 'inline scan ran (v1 strategy ignored)',
      usage: { scout: { costUsd: 0.01 }, reviewer: null },
      rubricGenerated: false,
    } as never);

    const result = await runDiscoveryScanTool.execute(
      { platform: 'x' },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.skipped).toBe(false);
    const callArg = vi.mocked(runDiscoveryV3).mock.calls[0]![0];
    expect(callArg.presetQueries).toBeUndefined();
  });

  it('surfaces scoutNotes and passes presetQueries from the cached strategy', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ platform: 'x' }]));
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([
        {
          id: 'p1',
          name: 'Shipflare',
          description: 'ship things',
          valueProp: null,
          keywords: ['ship', 'deploy'],
        },
      ]),
    );
    dbSelectMock.mockReturnValue(buildSelectChain([]));

    loadEntryMock.mockResolvedValueOnce(makeStrategyEntry('x'));
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);
    vi.mocked(runDiscoveryV3).mockResolvedValueOnce({
      verdicts: [],
      review: { ran: false, decision: { mode: 'skip' }, disagreements: null },
      scoutNotes:
        'Searched 22 tweets; rejected all (competitor reposts dominated).',
      usage: { scout: { costUsd: 0.018 }, reviewer: null },
      rubricGenerated: false,
    } as never);

    const result = await runDiscoveryScanTool.execute(
      { platform: 'x' },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.skipped).toBe(false);
    expect(result.queued).toHaveLength(0);
    expect(result.scoutNotes).toContain('rejected all');
    const callArg = vi.mocked(runDiscoveryV3).mock.calls[0]![0];
    expect(callArg.presetQueries).toEqual([
      'solo founder asking',
      '0 to first user',
    ]);
    expect(callArg.negativeTerms).toEqual(['affiliate']);
  });

  it('persists queued verdicts and returns thread summaries', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ platform: 'x' }]));
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([
        {
          id: 'p1',
          name: 'Shipflare',
          description: 'ship things',
          valueProp: null,
          keywords: ['ship', 'deploy'],
        },
      ]),
    );
    dbSelectMock.mockReturnValue(buildSelectChain([]));

    loadEntryMock.mockResolvedValueOnce(makeStrategyEntry('x'));
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);
    vi.mocked(runDiscoveryV3).mockResolvedValueOnce({
      verdicts: [
        {
          verdict: 'queue',
          externalId: 'tweet-1',
          platform: 'x',
          title: '',
          body: 'looking for shipflare alternatives',
          author: 'alice',
          url: 'https://x.com/alice/status/1',
          confidence: 0.92,
          reason: 'matches keywords + asking for tools',
        },
      ],
      review: { ran: false, decision: { mode: 'skip' }, disagreements: null },
      scoutNotes: '1 queueable found.',
      usage: { scout: { costUsd: 0.012 }, reviewer: null },
      rubricGenerated: false,
    } as never);
    vi.mocked(persistScoutVerdicts).mockResolvedValueOnce({ queued: 1 } as never);

    const result = await runDiscoveryScanTool.execute(
      { platform: 'x' },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.skipped).toBe(false);
    expect(result.queued).toHaveLength(1);
    expect(result.queued[0].externalId).toBe('tweet-1');
    expect(result.queued[0].confidence).toBe(0.92);
    expect(result.scanned).toBe(1);
    expect(result.scoutNotes).toBe('1 queueable found.');
  });

  it('emits a tool_progress event before scout runs', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ platform: 'x' }]));
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
    dbSelectMock.mockReturnValue(buildSelectChain([]));

    loadEntryMock.mockResolvedValueOnce(makeStrategyEntry('x'));
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);
    vi.mocked(runDiscoveryV3).mockResolvedValueOnce({
      verdicts: [],
      review: { ran: false, decision: { mode: 'skip' }, disagreements: null },
      scoutNotes: '',
      usage: { scout: { costUsd: 0.01 }, reviewer: null },
      rubricGenerated: false,
    } as never);

    const emit = vi.fn();
    const ctx = makeCtx({ userId: 'u1', productId: 'p1' });
    ctx.emitProgress = emit;

    await runDiscoveryScanTool.execute({ platform: 'x' }, ctx);

    expect(emit).toHaveBeenCalled();
    const firstCall = emit.mock.calls[0]!;
    expect(firstCall[0]).toBe('run_discovery_scan');
    expect(typeof firstCall[1]).toBe('string');
    expect(firstCall[1]).toMatch(/X|Reddit|querie/i);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `pnpm vitest run src/tools/RunDiscoveryScanTool/__tests__/RunDiscoveryScanTool.test.ts`

Expected: FAIL — `inlineQueryCount` not in input schema, `presetQueries: undefined` branch missing, emit not wired.

- [ ] **Step 3: Update the tool implementation**

In `src/tools/RunDiscoveryScanTool/RunDiscoveryScanTool.ts`:

(a) Replace `inputSchema` (line 33-38):

```ts
const inputSchema = z.object({
  platform: z.enum(['x', 'reddit']),
  /** Override default sources from platform-config; coordinator can pass
   * a narrower list (e.g. just 2 hot subreddits) for cheap onboarding scans. */
  sources: z.array(z.string().min(1)).optional(),
  /** Number of queries scout should generate when no calibrated strategy
   * exists in MemoryStore. Default (scout's): 8. Pass 12 from the kickoff
   * fast-path scan to deliberately span breadth (broad + medium + specific).
   * Ignored when a calibrated strategy is loaded. */
  inlineQueryCount: z.number().int().min(4).max(20).optional(),
});
```

(b) Update the `description` (line 90-99) — remove the `strategy_not_calibrated` sentence:

```ts
  description:
    'Run discovery scout on a platform (x | reddit). When a calibrated ' +
    'search strategy exists in MemoryStore it is loaded and used verbatim; ' +
    'otherwise scout falls back to inline query generation (pass ' +
    '`inlineQueryCount` to widen breadth — kickoff uses 12). Returns ' +
    'queue-worthy threads with confidence + reason and a `scoutNotes` ' +
    'summary explaining what was filtered. Threads are persisted to the ' +
    'threads table (state=queued); dispatch community-manager against the ' +
    'returned externalIds. Returns `skipped:true, reason:"no_${platform}_channel"` ' +
    'when no channel is connected.',
```

(c) Replace the strategy-loading block (lines ~133-149) — **delete the skip branch**, capture strategy as nullable:

```ts
    // Load the cached search strategy if present. When missing or at a
    // legacy schemaVersion we run scout in inline mode (no preset
    // queries) — the kickoff fast path relies on this so a fresh user
    // gets results without waiting for the full calibration loop.
    const store = new MemoryStore(userId, productId);
    const entry = await store.loadEntry(searchStrategyMemoryName(platform));
    const strategy = loadStrategy(entry?.content, platform);

    const config = getPlatformConfig(platform);
    const sources = input.sources ?? [...config.defaultSources];
```

(d) Above the existing `try { deps = await createPlatformDeps... }`, emit the pre-scout progress line:

```ts
    const queryCountForLog = strategy
      ? strategy.queries.length
      : input.inlineQueryCount ?? 8;
    ctx.emitProgress?.(
      'run_discovery_scan',
      `Searching ${platform} with ${queryCountForLog} ${strategy ? 'calibrated' : 'inline'} queries`,
      { platform, queryCount: queryCountForLog, mode: strategy ? 'calibrated' : 'inline' },
    );
```

(e) Update the `runDiscoveryV3` call (lines ~169-185) so it passes the inline knob and clears `presetQueries`/`negativeTerms` when no strategy:

```ts
    const result = await runDiscoveryV3(
      {
        userId,
        productId,
        platform,
        sources,
        product: {
          name: productRow.name,
          description: productRow.description,
          valueProp: productRow.valueProp ?? null,
          keywords: productRow.keywords,
        },
        ...(strategy
          ? { presetQueries: strategy.queries, negativeTerms: strategy.negativeTerms }
          : { inlineQueryCount: input.inlineQueryCount }),
      },
      deps,
    );
```

(f) After `persistScoutVerdicts` returns, emit the post-scan progress line:

```ts
    ctx.emitProgress?.(
      'run_discovery_scan',
      `Scanned ${result.verdicts.length} threads · ${queueVerdicts.length} queueable`,
      {
        platform,
        scanned: result.verdicts.length,
        queued: queueVerdicts.length,
      },
    );
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `pnpm vitest run src/tools/RunDiscoveryScanTool/__tests__/RunDiscoveryScanTool.test.ts`

Expected: PASS — all six cases.

- [ ] **Step 5: Verify build**

Run: `pnpm tsc --noEmit --pretty false 2>&1 | head -40`

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools/RunDiscoveryScanTool/RunDiscoveryScanTool.ts src/tools/RunDiscoveryScanTool/__tests__/RunDiscoveryScanTool.test.ts
git commit -m "refactor(run_discovery_scan): drop strategy_not_calibrated skip, add inlineQueryCount + emitProgress"
```

---

### Task 6: `CalibrateSearchTool` — inject `report_progress` for the strategist + inherit parent emitter

**Files:**
- Modify: `src/tools/CalibrateSearchTool/CalibrateSearchTool.ts`
- Modify: `src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts`

**Context:** The strategist is an LLM agent — it can't call `ctx.emitProgress` directly. We give it a `report_progress` tool whose **implementation is constructed by `calibrate_search_strategy.execute`** so it closes over the *outer* tool's `ctx.emitProgress` and emits with `toolName: 'calibrate_search_strategy'`. This is the per-spec sub-agent inheritance pattern.

- [ ] **Step 1: Inspect the existing test file shape**

```bash
sed -n '1,40p' src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts
```

You should see vitest mocks for `createPlatformDeps`, `runAgent`, etc. Take note of the import paths and mock helpers used — the new test re-uses them.

- [ ] **Step 2: Add the failing test**

Append to `src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts` (inside the existing `describe` block):

```ts
  it('injects a report_progress tool into the strategist that emits as calibrate_search_strategy', async () => {
    // Preflight: channel + product exist.
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ id: 'p1', name: 'Shipflare', description: 'ship', valueProp: null, keywords: ['ship'] }]));
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);

    // runAgent stub: capture the strategistConfig passed in, simulate
    // the strategist invoking report_progress mid-run, then return a
    // valid strategist output.
    let capturedReportProgress:
      | ((input: { message: string; metadata?: Record<string, unknown> }, ctx: any) => Promise<unknown>)
      | null = null;
    vi.mocked(runAgent).mockImplementationOnce(async (config: any, _msg, _subCtx) => {
      const reportTool = config.tools.find(
        (t: { name: string }) => t.name === 'report_progress',
      );
      capturedReportProgress = reportTool?.execute ?? null;
      return {
        result: {
          queries: ['q1'],
          negativeTerms: [],
          rationale: 'r',
          observedPrecision: 0.7,
          reachedTarget: true,
          turnsUsed: 5,
          sampleSize: 24,
          sampleVerdicts: [],
        },
        usage: { costUsd: 0.05 },
      } as never;
    });

    const emit = vi.fn();
    const ctx = makeCtx({ userId: 'u1', productId: 'p1', db: {} });
    ctx.emitProgress = emit;

    await calibrateSearchStrategyTool.execute({ platform: 'x' }, ctx);

    expect(capturedReportProgress).toBeTypeOf('function');

    // Simulate the strategist calling its injected report_progress tool.
    await capturedReportProgress!(
      { message: 'Round 12/60 · precision 0.58', metadata: { round: 12, maxTurns: 60, precision: 0.58 } },
      makeCtx({}),
    );

    expect(emit).toHaveBeenCalledWith(
      'calibrate_search_strategy',
      'Round 12/60 · precision 0.58',
      { round: 12, maxTurns: 60, precision: 0.58 },
    );
  });
```

(If the existing test file uses different mock names, adapt the variable names but keep the assertion shape.)

- [ ] **Step 3: Run tests to confirm failure**

Run: `pnpm vitest run src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts`

Expected: FAIL — `report_progress` tool is not yet injected; `runAgent` won't see one in `config.tools`.

- [ ] **Step 4: Implement the injection in `CalibrateSearchTool.ts`**

Add the new tool factory above `calibrateSearchStrategyTool`:

```ts
import { buildTool } from '@/core/tool-system';
// (already imported)

/**
 * Build a `report_progress` tool whose implementation is closed over
 * the outer calibrate-tool's emitter so it attributes progress to
 * `calibrate_search_strategy`. Strategist gets this in its toolset
 * for this single run; we don't add it to the global registry.
 */
function buildReportProgressTool(
  outerEmit: ToolContext['emitProgress'],
): ToolDefinition<{ message: string; metadata?: Record<string, unknown> }, { acknowledged: true }> {
  return buildTool({
    name: 'report_progress',
    description:
      'Emit a one-line progress update to the user. Call at the end of ' +
      'each iteration with key state. Message ≤200 chars; include round / ' +
      'precision / sampleSize in metadata for the UI to render structured.',
    inputSchema: z.object({
      message: z.string().min(1).max(200),
      metadata: z.record(z.unknown()).optional(),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input) {
      outerEmit?.('calibrate_search_strategy', input.message, input.metadata);
      return { acknowledged: true } as const;
    },
  });
}
```

(`ToolContext` and `ToolDefinition` types come from `@/core/types`. Add the import if not already present.)

Then inside `calibrateSearchStrategyTool.execute`, where `strategistConfig` is built (around line 161-167), inject the tool:

```ts
    const strategistConfig = buildAgentConfigFromDefinition(strategistDef);
    strategistConfig.maxTurns = maxTurns;
    strategistConfig.tools = [
      ...strategistConfig.tools,
      buildReportProgressTool(ctx.emitProgress),
    ];
```

- [ ] **Step 5: Run tests to confirm pass**

Run: `pnpm vitest run src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts`

Expected: PASS.

- [ ] **Step 6: Verify build**

Run: `pnpm tsc --noEmit --pretty false 2>&1 | head -40`

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/tools/CalibrateSearchTool/CalibrateSearchTool.ts src/tools/CalibrateSearchTool/__tests__/CalibrateSearchTool.test.ts
git commit -m "feat(calibrate): inject report_progress tool into strategist for live updates"
```

---

## Phase 3 — Agent system prompts

### Task 7: Update `discovery-scout` AGENT.md — breadth-spanning + `inlineQueryCount` in input shape

**Files:**
- Modify: `src/tools/AgentTool/agents/discovery-scout/AGENT.md`

**Context:** The scout already has the `presetQueries: null` inline branch (line 59: "Otherwise (legacy / cold path), generate 2-8 queries from `sources` + `intent` + product keywords"). We expand the input shape to declare `inlineQueryCount` and add a one-paragraph rule for breadth-spanning when count ≥ 10.

- [ ] **Step 1: Update the input shape (around line 22-43)**

Replace the existing input block in `src/tools/AgentTool/agents/discovery-scout/AGENT.md`:

```markdown
## Input (passed by caller as prompt)

```
platform: 'x' | 'reddit'
sources: string[]              // one per query; caller-ordered
product: {
  name, description, valueProp, keywords
}
intent?: string                // optional free-form "what to look for"
                               // from coordinator (empty on cron runs)
coldStart: boolean             // true when MemoryStore has no
                               // approve/skip labels for this product
presetQueries?: string[]       // calibrated queries from the cached
                               // search strategy. When non-empty, you
                               // SKIP query generation and run these
                               // verbatim. See "Workflow" below.
negativeTerms?: string[]       // anti-signal terms learned during
                               // calibration. Use them to deprioritise
                               // matching results; do NOT inject as
                               // search operators (the strategy already
                               // accounted for that).
inlineQueryCount?: number      // when `presetQueries` is empty/absent,
                               // produce this many queries instead of
                               // your 2-8 default. Kickoff sets this to
                               // 12 to deliberately span breadth so the
                               // first scan returns something even
                               // before calibration has run.
```
```

- [ ] **Step 2: Update the X workflow's inline branch (around line 54-61)**

Replace the bullet starting `1. **If presetQueries is non-empty...**`:

```markdown
1. **If `presetQueries` is non-empty, use it verbatim** — these are
   the cached, pre-calibrated queries. Skip generation. Skip the
   "compress related phrasings" step. Just feed them to
   `x_search_batch`. The one-time `search-strategist` already paid
   the design cost; your job here is judgment, not query design.
   Otherwise (cold / fast-path) generate queries from `sources` +
   `intent` + product keywords. Default count: **2-8**. When
   `inlineQueryCount >= 10`, deliberately span breadth instead of
   compressing — produce roughly:
     - 3-4 **broad** queries (product name, category, top-level pain),
     - 4-5 **medium** queries (specific pain phrasings, value-prop language),
     - 3-4 **specific** queries (ICP voice — "solo founder asking",
       subreddit-native phrasings, niche operators).
   Breadth beats precision for the kickoff first round; calibration
   will refine on the next scan.
```

- [ ] **Step 3: Verify the file is well-formed**

```bash
head -100 src/tools/AgentTool/agents/discovery-scout/AGENT.md
```

Expected: structure intact, indentation matches surrounding bullets.

- [ ] **Step 4: Commit**

```bash
git add src/tools/AgentTool/agents/discovery-scout/AGENT.md
git commit -m "docs(scout): document inlineQueryCount + breadth-spanning at kickoff"
```

---

### Task 8: Update `search-strategist` AGENT.md — call `report_progress` per turn

**Files:**
- Modify: `src/tools/AgentTool/agents/search-strategist/AGENT.md`

**Context:** Add `report_progress` to the strategist's allowed tools and instruct it to call the tool at the end of every iteration with the round/precision payload the UI expects.

- [ ] **Step 1: Add `report_progress` to the frontmatter `tools` list**

Edit the YAML frontmatter at the top of `src/tools/AgentTool/agents/search-strategist/AGENT.md`:

```yaml
tools:
  - x_search_batch
  - reddit_search
  - StructuredOutput
  - report_progress
```

- [ ] **Step 2: Add a Reporting section after the iteration-loop docs**

After the section that describes the iteration loop (search for `## Iteration loop`, then go to the end of that section before the next `##` heading), insert:

```markdown
## Reporting progress

At the **end of every iteration** — after you've decided your next
move and updated `BEST_SEEN` — call:

```
report_progress({
  message: "Round {turnCount}/{maxTurns} · precision {precision.toFixed(2)} · {move}",
  metadata: {
    round: turnCount,
    maxTurns: maxTurns,
    precision: precision,
    sampleSize: judgedTweets,
  },
})
```

Where `{move}` is one of `seed | swap-one | narrow | widen | regenerate | retry | deliver`.

This drives the live calibration row in the user's `/today` status
card. It is best-effort UI decoration — if the call returns
`{ acknowledged: true }` you keep going; do not retry on error and
do not block on it.

Do **not** call `report_progress` more than once per iteration.
```

- [ ] **Step 3: Spot-check the file**

```bash
grep -n "report_progress\|Reporting progress" src/tools/AgentTool/agents/search-strategist/AGENT.md
```

Expected: `tools:` block contains `report_progress`; the new section header exists; the call template is present.

- [ ] **Step 4: Commit**

```bash
git add src/tools/AgentTool/agents/search-strategist/AGENT.md
git commit -m "docs(strategist): instruct per-turn report_progress calls for live status"
```

---

## Phase 4 — Coordinator playbook + kickoff orchestration

### Task 9: Coordinator AGENT.md — kickoff playbook reorder + 0-result fallback + cron cleanup

**Files:**
- Modify: `src/tools/AgentTool/agents/coordinator/AGENT.md`

**Context:** The kickoff playbook today is `1 → 2 → 3 → 4` (plan → calibrate → scan → reply). This change reorders to `1 → 3 → 4 → 2 → 3'` so reply drafts land in `/today` before calibration. The 0-result fallback re-collapses to `1 → 2 → 3 → 4` (calibrate-then-scan-then-reply) only when the inline scan returns no queueable threads. Separately, the `discovery_cron` playbook had a "if scan returned strategy_not_calibrated, calibrate then re-scan" branch that becomes dead code after Task 5 (the skipped path is gone). Delete it.

- [ ] **Step 1: Replace the `trigger: 'kickoff'` section (lines 86-132)**

Replace the entire section starting at `### \`trigger: 'kickoff'\`` and ending before `### \`trigger: 'discovery_cron'\``. **Note:** uses bold step labels instead of a numbered list because the logical order (`1 → 3 → 4 → 2 → 3'`) is non-sequential — markdown's auto-numbering would mangle it.

````markdown
### `trigger: 'kickoff'` (first time the founder enters team chat)

The user just landed in /team for the first time. They have a
strategic_path + plan from onboarding, and the AI team is now visibly
working for them. Your kickoff produces FIVE artifacts the founder
will read in the chat: **plan draft → search → drafts → calibration →
refreshed search.**

Run them in order. Steps are sequential — do NOT parallelize. The
ordering is deliberate: the founder needs to see post + reply drafts
in `/today` *before* calibration runs, so step 3 happens **before**
step 2 in your dispatch order.

**Step 1 — Plan draft.** Spawn content-planner. **Extract
`weekStart=...` and `now=...` from the goal preamble and pass them
verbatim into the prompt** — the planner needs them to anchor
scheduling and refuse past-dated items:

```
Task({
  subagent_type: 'content-planner',
  description: 'plan week-1 items',
  prompt: 'weekStart: <weekStart from goal>\nnow: <now from goal>\npathId: <strategicPathId from goal>\ntrigger: kickoff'
})
```

If the goal preamble does NOT carry `weekStart=` (older callers),
fall back to today's Monday 00:00 UTC.

**Step 3 — Search (fast-path).**
`run_discovery_scan({ platform: 'x', inlineQueryCount: 12 })` (or the
primary connected platform). This first scan runs scout in inline
mode with a deliberately broad 12-query set so the founder sees
results within ~60s. Returns `{ queued, scoutNotes, scanned }`.

**Step 4 — Drafts.**
If `queued.length > 0`, dispatch community-manager on the top 3 by
confidence:
`Task({ subagent_type: 'community-manager', description: 'draft top-3 replies', prompt: <thread list> })`.
community-manager owns reply drafting end-to-end.
If `queued.length === 0`, **skip step 4 entirely** and proceed to
step 2 — there's nothing to draft yet, the calibrated re-scan in
step 3' (or the immediate post-step-2 scan in the 0-queued branch)
will produce the first reply targets.

**Step 2 — Calibration.**
`calibrate_search_strategy({ platform: 'x' })`. This spawns
search-strategist, runs an open-ended iterate-until-precision loop,
and persists the winning strategy to MemoryStore. Returns
`{ saved, observedPrecision, reachedTarget, queries, rationale }`.
Runs in the background while the founder works in `/today`.

**Step 3' — Refreshed search.**
`run_discovery_scan({ platform: 'x' })` — no `inlineQueryCount`,
uses the calibrated strategy from step 2 verbatim. New threads
dedupe-insert into the inbox. **Skip this step if you took the
0-queued branch in step 4** — in that branch, run a single
`run_discovery_scan({ platform: 'x' })` immediately after step 2
(which becomes the first reply-eligible scan) and dispatch
community-manager on its `queued` results.

If the user has no channels connected, skip steps 2-3-3'-4 and tell
them "Connect X to see your scout in action."

Final user-facing summary lists the artifacts:
- Plan: N items scheduled
- Discovery (initial): K threads scanned, J drafts ready for review
  (or `scoutNotes` excerpt when J=0 — never just "no relevant
  conversations" without the scout's reasoning)
- Calibration: M queries, X% precision over S judged tweets
  (target 70%, reached / not reached), one-line rationale
- Discovery (calibrated): K' new threads added (when step 3' ran)
````

- [ ] **Step 2: Simplify the `discovery_cron` section (lines 134-158)**

Replace the body of `### \`trigger: 'discovery_cron'\`` so the dead `strategy_not_calibrated` recovery branch is gone:

```markdown
### `trigger: 'discovery_cron'` (daily 13:00 UTC)

Daily discovery sweep. Run scans yourself; only dispatch community-manager
if there's something to draft:

1. Call `run_discovery_scan({ platform: 'x' })` (and `{ platform: 'reddit' }`
   if reddit is connected — emit both calls in one response so they run
   in parallel). When a calibrated strategy exists in MemoryStore the
   tool uses it; otherwise it falls back to inline mode automatically
   (no `strategy_not_calibrated` skip — the tool deletes that branch).
2. Combine the `queued` arrays across platforms and pick the top 3 by
   `confidence`. If non-empty:
   `Task({ subagent_type: 'community-manager', description: 'draft top-3 replies', prompt: <thread list> })`
3. If every scan returned 0 queued threads, your final reply quotes the
   `scoutNotes` from each scan — "Scanned X today; <scoutNotes>". Do
   NOT just say "no relevant conversations" without the reasoning.

Do NOT dispatch content-planner on a `discovery_cron` trigger — weekly
planning is owned by a separate weekly cron.
```

- [ ] **Step 3: Spot-check**

```bash
grep -n "strategy_not_calibrated\|inlineQueryCount\|step 3'\|0-queued" src/tools/AgentTool/agents/coordinator/AGENT.md
```

Expected: zero hits for `strategy_not_calibrated`; `inlineQueryCount` and `step 3'` present.

- [ ] **Step 4: Commit**

```bash
git add src/tools/AgentTool/agents/coordinator/AGENT.md
git commit -m "docs(coordinator): reorder kickoff playbook for fast-path reply drafts"
```

---

### Task 10: `team-kickoff.ts` — rewrite goal text + update tests

**Files:**
- Modify: `src/lib/team-kickoff.ts:113-145`
- Modify: `src/lib/__tests__/team-kickoff.test.ts:108-112`

**Context:** The team-run worker hands the coordinator its kickoff goal as a string. The string declares the step list explicitly so the coordinator picks up the new order even before its AGENT.md is re-read. The test asserts the new ordering is reflected.

- [ ] **Step 1: Update the failing test first**

In `src/lib/__tests__/team-kickoff.test.ts`, replace the four `expect(callArg.goal).toContain(...)` lines (around lines 108-112) with:

```ts
    expect(callArg.goal).toContain('weekStart=');
    expect(callArg.goal).toContain('now=');
    expect(callArg.goal).toContain('pathId=path-1');
    // New playbook ordering: plan → scan → drafts → calibrate → re-scan.
    expect(callArg.goal).toContain('content-planner');
    expect(callArg.goal).toContain(
      "run_discovery_scan({ platform: 'x', inlineQueryCount: 12 })",
    );
    expect(callArg.goal).toContain('community-manager');
    expect(callArg.goal).toContain("calibrate_search_strategy({ platform: 'x' })");
    // Step 3' — second scan, no inlineQueryCount.
    expect(callArg.goal).toContain("run_discovery_scan({ platform: 'x' })");
    // 0-result fallback referenced.
    expect(callArg.goal).toContain('queued');
    expect(callArg.goal).toContain('Skip steps 2-3-3\'-4 if no channels');
    // Order assertion: scan happens before calibration.
    const goal: string = callArg.goal;
    const scanIdx = goal.indexOf("run_discovery_scan({ platform: 'x', inlineQueryCount: 12 })");
    const calibrateIdx = goal.indexOf('calibrate_search_strategy');
    expect(scanIdx).toBeGreaterThan(0);
    expect(calibrateIdx).toBeGreaterThan(scanIdx);
```

- [ ] **Step 2: Run test to confirm failure**

Run: `pnpm vitest run src/lib/__tests__/team-kickoff.test.ts`

Expected: FAIL — current goal text does not contain `inlineQueryCount: 12` and the order assertion is reversed.

- [ ] **Step 3: Rewrite the `goal` string in `src/lib/team-kickoff.ts`**

Replace the `goal` template (lines ~134-145):

```ts
  const goal =
    `First-visit kickoff for ${productRow.name}. ` +
    (pathId ? `Strategic path pathId=${pathId}. ` : '') +
    `weekStart=${kickoffWeekStart} now=${kickoffNow.toISOString()}. ` +
    `Connected channels: ${channels.join(', ') || 'none'}. ` +
    `Trigger: kickoff. ` +
    `Follow your kickoff playbook end-to-end (plan → scan → drafts → calibrate → re-scan): ` +
    `(1) Task content-planner for week-1 plan items — pass weekStart + now in its prompt verbatim, ` +
    `(2) call run_discovery_scan({ platform: '${primary}', inlineQueryCount: 12 }) — fast-path inline scan so the founder sees drafts immediately, ` +
    `(3) Task community-manager on the top-3 queued threads (skip this step if scan returned 0 queued), ` +
    `(4) call calibrate_search_strategy({ platform: '${primary}' }) — runs in background while founder uses /today, ` +
    `(5) call run_discovery_scan({ platform: '${primary}' }) — uses the calibrated strategy from step 4, dedupe-inserts new threads. ` +
    `Skip step 5 if you took the 0-queued branch in step 3 (the post-calibration scan there is already calibrated). ` +
    `Skip steps 2-3-3'-4 if no channels are connected.`;
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm vitest run src/lib/__tests__/team-kickoff.test.ts`

Expected: PASS.

- [ ] **Step 5: Verify build**

Run: `pnpm tsc --noEmit --pretty false 2>&1 | head -40`

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/team-kickoff.ts src/lib/__tests__/team-kickoff.test.ts
git commit -m "feat(team-kickoff): rewrite goal text for fast-path kickoff order"
```

---

## Phase 5 — UI

### Task 11: `TacticalProgressCard` — `tool_progress` reducer + maxRounds → maxTurns rename + ActivityTicker

**Files:**
- Modify: `src/components/today/tactical-progress-card.tsx`
- Create: `src/components/today/__tests__/tactical-progress-card-reducer.test.ts`

**Context:** The card is `'use client'` and currently subscribes to `useSSEChannel('agents', ...)` filtering for `calibration_progress` / `calibration_complete` events. Those legacy event types are not produced anymore; the tactical-progress-card.tsx file still references them. We replace the reducer with a `tool_progress` consumer that routes by `toolName`, rename the `maxRounds` field on `CalibrationView` to `maxTurns` to match the canonical strategist parameter (no shim), and add a generic `ActivityTicker` row for unknown `toolName`s.

The reducer is extracted into a pure function so we can unit-test it without rendering React.

- [ ] **Step 1: Write the reducer unit test**

```ts
// src/components/today/__tests__/tactical-progress-card-reducer.test.ts
import { describe, it, expect } from 'vitest';
import {
  reduceToolProgress,
  type ToolProgressViewState,
  type ToolProgressEventInput,
} from '../tactical-progress-card';

const empty: ToolProgressViewState = {
  calibration: {},
  discovery: {},
  ticker: null,
};

describe('reduceToolProgress', () => {
  it('routes calibrate_search_strategy events to the calibration map', () => {
    const event: ToolProgressEventInput = {
      type: 'tool_progress',
      toolName: 'calibrate_search_strategy',
      callId: 'c1',
      message: 'Round 12/60 · precision 0.58',
      metadata: { round: 12, maxTurns: 60, precision: 0.58, sampleSize: 47 },
      ts: 1000,
    };
    const next = reduceToolProgress(empty, event);
    expect(next.calibration['x'] ?? next.calibration['default']).toBeDefined();
    const row = next.calibration['default']!;
    expect(row.round).toBe(12);
    expect(row.maxTurns).toBe(60);
    expect(row.precision).toBeCloseTo(0.58);
    expect(row.message).toBe('Round 12/60 · precision 0.58');
    expect(row.ts).toBe(1000);
  });

  it('routes run_discovery_scan events to the discovery map keyed by platform', () => {
    const event: ToolProgressEventInput = {
      type: 'tool_progress',
      toolName: 'run_discovery_scan',
      callId: 'c2',
      message: 'Searching x with 12 inline queries',
      metadata: { platform: 'x', queryCount: 12, mode: 'inline' },
      ts: 2000,
    };
    const next = reduceToolProgress(empty, event);
    expect(next.discovery['x']).toBeDefined();
    expect(next.discovery['x']!.message).toBe('Searching x with 12 inline queries');
  });

  it('drops out-of-order events for the same toolName + callId', () => {
    const newer: ToolProgressEventInput = {
      type: 'tool_progress',
      toolName: 'calibrate_search_strategy',
      callId: 'c1',
      message: 'Round 12',
      metadata: { round: 12, maxTurns: 60 },
      ts: 1000,
    };
    const older: ToolProgressEventInput = {
      type: 'tool_progress',
      toolName: 'calibrate_search_strategy',
      callId: 'c1',
      message: 'Round 8',
      metadata: { round: 8, maxTurns: 60 },
      ts: 500,
    };
    const afterNewer = reduceToolProgress(empty, newer);
    const afterOlder = reduceToolProgress(afterNewer, older);
    // The older event should not overwrite the newer.
    expect(afterOlder.calibration['default']!.round).toBe(12);
    expect(afterOlder.calibration['default']!.message).toBe('Round 12');
  });

  it('falls through to ActivityTicker for unknown toolNames', () => {
    const event: ToolProgressEventInput = {
      type: 'tool_progress',
      toolName: 'some_future_tool',
      callId: 'c3',
      message: 'doing a thing 5/10',
      ts: 3000,
    };
    const next = reduceToolProgress(empty, event);
    expect(next.ticker?.message).toBe('doing a thing 5/10');
    expect(next.ticker?.toolName).toBe('some_future_tool');
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm vitest run src/components/today/__tests__/tactical-progress-card-reducer.test.ts`

Expected: FAIL — `reduceToolProgress`, `ToolProgressViewState`, `ToolProgressEventInput` not exported.

- [ ] **Step 3: Refactor `tactical-progress-card.tsx`**

The full file is too long to inline here in one diff; the changes are:

(a) **Delete** the `CalibrationProgress` and `CalibrationComplete` interface definitions and the `reduceCalibrationLive` function (around lines 66-171). Their `tactical_generate_*` and `calibration_progress`/`calibration_complete` event types are gone.

(b) **Add** the new exports near the top of the file (after the existing imports, before `INITIAL_VIEW`):

```ts
/* ─── Generic tool_progress reducer ──────────────────────────────────── */

export interface ToolProgressEventInput {
  type: 'tool_progress';
  toolName: string;
  callId: string;
  message: string;
  metadata?: Record<string, unknown>;
  ts: number;
}

export interface CalibrationRow {
  platform: string;
  callId: string;
  round: number | null;
  maxTurns: number | null;
  precision: number | null;
  sampleSize: number | null;
  message: string;
  ts: number;
}

export interface DiscoveryRow {
  platform: string;
  callId: string;
  mode: 'inline' | 'calibrated' | null;
  queryCount: number | null;
  message: string;
  ts: number;
}

export interface TickerRow {
  toolName: string;
  callId: string;
  message: string;
  ts: number;
}

export interface ToolProgressViewState {
  calibration: Record<string, CalibrationRow>;
  discovery: Record<string, DiscoveryRow>;
  ticker: TickerRow | null;
}

const INITIAL_TOOL_PROGRESS: ToolProgressViewState = {
  calibration: {},
  discovery: {},
  ticker: null,
};

function readNumber(meta: Record<string, unknown> | undefined, key: string): number | null {
  const v = meta?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readString(meta: Record<string, unknown> | undefined, key: string): string | null {
  const v = meta?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function reduceToolProgress(
  state: ToolProgressViewState,
  event: ToolProgressEventInput,
): ToolProgressViewState {
  if (event.type !== 'tool_progress') return state;

  if (event.toolName === 'calibrate_search_strategy') {
    const platform = readString(event.metadata, 'platform') ?? 'default';
    const prev = state.calibration[platform];
    if (prev && prev.callId === event.callId && prev.ts >= event.ts) {
      return state;
    }
    return {
      ...state,
      calibration: {
        ...state.calibration,
        [platform]: {
          platform,
          callId: event.callId,
          round: readNumber(event.metadata, 'round'),
          maxTurns: readNumber(event.metadata, 'maxTurns'),
          precision: readNumber(event.metadata, 'precision'),
          sampleSize: readNumber(event.metadata, 'sampleSize'),
          message: event.message,
          ts: event.ts,
        },
      },
    };
  }

  if (event.toolName === 'run_discovery_scan') {
    const platform = readString(event.metadata, 'platform') ?? 'default';
    const prev = state.discovery[platform];
    if (prev && prev.callId === event.callId && prev.ts >= event.ts) {
      return state;
    }
    const modeRaw = readString(event.metadata, 'mode');
    const mode: DiscoveryRow['mode'] =
      modeRaw === 'inline' || modeRaw === 'calibrated' ? modeRaw : null;
    return {
      ...state,
      discovery: {
        ...state.discovery,
        [platform]: {
          platform,
          callId: event.callId,
          mode,
          queryCount: readNumber(event.metadata, 'queryCount'),
          message: event.message,
          ts: event.ts,
        },
      },
    };
  }

  // Unknown / future tool — surface in the activity ticker.
  if (state.ticker && state.ticker.callId === event.callId && state.ticker.ts >= event.ts) {
    return state;
  }
  return {
    ...state,
    ticker: {
      toolName: event.toolName,
      callId: event.callId,
      message: event.message,
      ts: event.ts,
    },
  };
}
```

(c) **Replace the `useSSEChannel` callback** (around lines 322-337) so it feeds the new reducer. Add a `toolProgress` slice to the component's view state:

```ts
const [toolProgress, setToolProgress] = useState<ToolProgressViewState>(
  INITIAL_TOOL_PROGRESS,
);

const handleAgentsEvent = useCallback((data: unknown) => {
  if (
    !data ||
    typeof data !== 'object' ||
    !('type' in data) ||
    (data as { type: unknown }).type !== 'tool_progress'
  ) {
    return;
  }
  setToolProgress((prev) => reduceToolProgress(prev, data as ToolProgressEventInput));
}, []);
useSSEChannel('agents', handleAgentsEvent);
```

(d) **Replace the `CalibrationSection` and `CalibrationRowView` components** so they read from the new `CalibrationRow` shape (rename every `maxRounds` reference to `maxTurns`; the `roundText` helper becomes `${row.maxTurns ? \`Round ${row.round ?? '?'}/${row.maxTurns}\` : \`Round ${row.round ?? '?'}\`}`). Drop the old `CalibrationView` interface entirely.

(e) **Add a `DiscoverySection`**:

```tsx
function DiscoverySection({
  rows,
  hasDivider,
}: {
  rows: DiscoveryRow[];
  hasDivider: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div
      style={{
        padding: '14px 20px',
        borderTop: hasDivider ? '1px solid rgba(0,0,0,0.06)' : undefined,
      }}
    >
      <OnbMono style={{ marginBottom: 10, display: 'inline-block' }}>
        Discovery
      </OnbMono>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => (
          <div
            key={r.platform}
            style={{
              fontSize: 13,
              color: 'var(--sf-fg-2)',
              letterSpacing: '-0.16px',
            }}
          >
            <strong style={{ color: 'var(--sf-fg-1)' }}>
              {(PLATFORMS[r.platform]?.displayName ?? r.platform)}
            </strong>{' '}
            · {r.message}
          </div>
        ))}
      </div>
    </div>
  );
}
```

(f) **Add an `ActivityTicker`**:

```tsx
function ActivityTicker({
  row,
  hasDivider,
}: {
  row: TickerRow | null;
  hasDivider: boolean;
}) {
  if (!row) return null;
  return (
    <div
      style={{
        padding: '10px 20px',
        borderTop: hasDivider ? '1px solid rgba(0,0,0,0.06)' : undefined,
        fontSize: 12,
        color: 'var(--sf-fg-3)',
        fontFamily: 'var(--sf-font-mono, monospace)',
        letterSpacing: 'var(--sf-track-mono)',
      }}
    >
      {row.message}
    </div>
  );
}
```

(g) **Update the visibility predicate `shouldRemainVisible`** so it also returns `true` while ANY in-flight `toolProgress` slice is non-empty (calibration row or discovery row present, OR ticker recently updated within ~30s).

(h) **Update the render path** in the `TacticalProgressCard` body so it stitches:

```
TacticalSection (existing)
  → CalibrationSection (rows from toolProgress.calibration)
  → DiscoverySection (rows from toolProgress.discovery)
  → ActivityTicker (toolProgress.ticker)
  → DismissHandle (if everything is done)
```

- [ ] **Step 4: Run reducer tests + tsc**

```bash
pnpm vitest run src/components/today/__tests__/tactical-progress-card-reducer.test.ts
pnpm tsc --noEmit --pretty false 2>&1 | head -40
```

Expected: PASS, clean type-check.

- [ ] **Step 5: Manual sanity-check the file size**

```bash
wc -l src/components/today/tactical-progress-card.tsx
```

Expected: file shouldn't have grown beyond ~800 lines. If it did, consider extracting reducer + sections to sibling files (`tactical-progress-card-reducer.ts`, `tactical-progress-card-sections.tsx`); commit the extraction as a separate refactor commit before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/components/today/tactical-progress-card.tsx src/components/today/__tests__/tactical-progress-card-reducer.test.ts
git commit -m "feat(today): generic tool_progress reducer + DiscoverySection + ActivityTicker"
```

---

### Task 12: `/api/today/progress` returns real calibration state from MemoryStore

**Files:**
- Modify: `src/app/api/today/progress/route.ts`

**Context:** The snapshot endpoint currently hard-codes `calibration: { platforms: [] }`. After Task 11 the UI reseeds from this snapshot on mount; if the user reloads `/today` mid-calibration we need real data so the calibration row keeps showing. We look up the platforms the user has channels for, check MemoryStore for `${platform}-search-strategy`, and report `completed | running | pending` accordingly.

For the running case we don't have a turn-by-turn live state (that's covered by SSE re-subscription); the snapshot just reports `running` and lets the next `tool_progress` event hydrate `round` / `precision`.

- [ ] **Step 1: Locate the existing buildSnapshot stub**

```bash
grep -n "calibration: { platforms: \[\] }\|loadTacticalStatus\|buildSnapshot" src/app/api/today/progress/route.ts
```

Expected: find the `buildSnapshot` function that returns `{ tactical, teamRun, calibration: { platforms: [] } }`.

- [ ] **Step 2: Replace `buildSnapshot` with a real query**

```ts
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { products } from '@/lib/db/schema';
import { MemoryStore } from '@/memory/store';
import { searchStrategyMemoryName } from '@/tools/CalibrateSearchTool/strategy-memory';
import { getActiveTeamRun } from '@/lib/team-runs'; // if exists; otherwise inline
import { and, eq } from 'drizzle-orm';
// (some of these imports may already be present — fold in rather than duplicate)

async function buildSnapshot(userId: string): Promise<ProgressSnapshot> {
  const { tactical, teamRun } = await loadTacticalStatus(userId);

  // Discover which platforms the user has channels for. We only need
  // calibration state for connected platforms — no point reporting on
  // platforms the user can't even use.
  const channelRows = await db
    .select({ platform: channels.platform })
    .from(channels)
    .where(eq(channels.userId, userId));
  const userPlatforms = Array.from(
    new Set(channelRows.map((r) => r.platform).filter((p): p is 'x' | 'reddit' => p === 'x' || p === 'reddit')),
  );

  // We need productId for MemoryStore (keyed per product).
  const [productRow] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  const platforms: PlatformCalibration[] = [];
  if (productRow) {
    const store = new MemoryStore(userId, productRow.id);
    for (const platform of userPlatforms) {
      const entry = await store.loadEntry(searchStrategyMemoryName(platform));
      if (!entry) {
        platforms.push({ platform, status: 'pending', precision: null, round: 0 });
        continue;
      }
      // Parse the persisted strategy to surface its precision.
      let precision: number | null = null;
      try {
        const parsed = JSON.parse(entry.content) as { observedPrecision?: number };
        if (typeof parsed.observedPrecision === 'number') {
          precision = parsed.observedPrecision;
        }
      } catch {
        // Malformed entry; treat as pending so a re-calibration can replace it.
        platforms.push({ platform, status: 'pending', precision: null, round: 0 });
        continue;
      }
      platforms.push({ platform, status: 'completed', precision, round: 0 });
    }
  }

  return {
    tactical,
    teamRun,
    calibration: { platforms },
  };
}
```

(If `loadTacticalStatus` already pulls `productId`, refactor to share the lookup rather than re-querying.)

- [ ] **Step 3: Verify build**

```bash
pnpm tsc --noEmit --pretty false 2>&1 | head -40
```

Expected: clean.

- [ ] **Step 4: Smoke test the endpoint manually (optional)**

If a dev server is running, visit `/api/today/progress` while signed in and confirm the JSON response now contains `calibration.platforms` with `{ platform: 'x', status: 'completed', precision: 0.7x, round: 0 }` for a calibrated user.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/today/progress/route.ts
git commit -m "feat(today): /api/today/progress returns real calibration state from MemoryStore"
```

---

## Phase 6 — Final integration checks

### Task 13: Full type + test suite + manual verification notes

**Files:** none modified (verification-only). If anything fails, fix and re-commit per the failing component's task above.

- [ ] **Step 1: Full TypeScript check**

```bash
pnpm tsc --noEmit --pretty false 2>&1 | tail -20
```

Expected: zero errors. If errors mention removed `CalibrationView.maxRounds`, `strategy_not_calibrated`, or `tactical_generate_*` symbols anywhere besides test files we've already updated, fix the offending callsite (the spec mandates no `// removed` placeholders).

- [ ] **Step 2: Full vitest suite**

```bash
pnpm vitest run 2>&1 | tail -30
```

Expected: green. If any pre-existing test referenced `strategy_not_calibrated`, `maxRounds`, or `calibration_progress`/`calibration_complete` event types, delete the assertion or update it in line with the new contract.

- [ ] **Step 3: Manual verification script (write to a scratch file, do not commit)**

Run a clean onboarding pass on local:

1. `psql shipflare_dev -c "TRUNCATE products, plans, plan_items, threads, strategic_paths, team_runs, team_messages, automation_conversations RESTART IDENTITY CASCADE"` (adjust table list to your dev schema; do NOT run on prod).
2. `redis-cli FLUSHDB`.
3. `pnpm dev`. Sign in, complete onboarding.
4. After commit, watch `/team` — you should see chief-of-staff dispatch in this order: `content-planner` → `run_discovery_scan` (with `inlineQueryCount: 12`) → `community-manager` → `calibrate_search_strategy` → `run_discovery_scan` (no inline arg).
5. Switch to `/today` within ~90s — confirm post drafts and reply drafts both appear; the progress card at the top shows a Discovery row, then a Calibration row with `Round n/60 · precision X` updating, plus a generic ticker line.
6. Wait through calibration; confirm new reply cards land via dedupe-insert when step 5 runs.
7. After ~5 seconds of all-completed state, the card collapses.

- [ ] **Step 4: Squash-commit the integration check (only if anything was fixed)**

```bash
git commit --allow-empty -m "chore: integration check passes for kickoff fast-path + tool-progress"
```

(Skip if no fixes were needed.)

---

## Self-review checklist

Run through this before handing the plan off:

- [ ] **Spec coverage:** every section of `2026-04-26-kickoff-fast-path-and-tool-progress-design.md` maps to at least one task. The "Components" sections (Tool layer / Agent layer / Generic infra / Playbook / UI / Snapshot) ↔ Tasks 1-12. The "Data flow" timeline is verified by Task 13's manual script.
- [ ] **Placeholder scan:** no `TBD`, no `add appropriate ...`, no `similar to Task N`. All code is concrete.
- [ ] **Type consistency:** `emitProgress` signature `(toolName: string, message: string, metadata?: Record<string, unknown>) => void` is used consistently in Tasks 2, 5, 6, 11. `ToolProgressEvent` shape (toolName / callId / message / metadata / ts) matches between Task 1's helper, Task 11's reducer, and Task 12's snapshot. The `inlineQueryCount` field is introduced in Task 4 (`V3PipelineInput`), Task 5 (`runDiscoveryScanTool` schema + plumbing), Task 7 (scout AGENT.md input shape), and Task 10 (kickoff goal text) — all four agree on the name and the 4-20 range.
- [ ] **Backwards-compat audit:** no shim left behind. The `strategy_not_calibrated` skipped result (Task 5), the `tactical_generate_*` event types (Task 11 step 3a deletion), the `CalibrationView.maxRounds` field (Task 11 step 3d rename), the cron's `if skipped: strategy_not_calibrated` recovery branch (Task 9 step 2), and the legacy `calibration_progress`/`calibration_complete` reducer (Task 11 step 3a) are all deleted, not gated.
