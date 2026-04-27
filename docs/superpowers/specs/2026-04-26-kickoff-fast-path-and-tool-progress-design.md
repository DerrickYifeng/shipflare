# Kickoff Fast Path & Generic Tool-Progress Events

**Date:** 2026-04-26
**Status:** approved (brainstorming complete, awaiting plan)

## Problem

Onboarding completes → user is redirected to `/team?from=onboarding` → the kickoff team-run starts running its playbook. The current playbook is:

1. `content-planner` writes plan_items
2. `calibrate_search_strategy({ platform: primary })` — runs the search-strategist agent through ~60 turns of search/judge/evolve to find a high-precision query set (**~10 minutes**)
3. `run_discovery_scan({ platform: primary })` — uses the calibrated strategy
4. `community-manager` drafts replies for the top-3 queued threads

The user lands on `/team`, watches the chief of staff dispatch step 1, then sits through ~10 minutes of calibration before any reply drafts exist. `/today` is empty for the duration. This is the dominant first-impression failure mode.

A second, related observation: slow tools in general (`calibrate_search_strategy`, `run_discovery_scan`, xAI bio lookup, `x_search_batch`) all need log-style progress feedback so the user can tell the program is running, not stuck. We should not solve this one tool at a time.

## Goals

1. User sees post drafts AND reply drafts on `/today` within ~1 minute of finishing onboarding.
2. Calibration still runs to completion, just in the background; once done, `/today` upgrades to higher-precision discoveries.
3. `/today` exposes a status bar with log-style progress lines for any slow tool — calibration, scan, bio lookup, and any future slow tool — through one shared mechanism.

## Non-goals

- Multi-channel fan-out at kickoff. Today only the primary platform calibrates; this design preserves that. Reddit calibration on connect is a separate change.
- Changing the post-onboarding landing page. User still lands on `/team?from=onboarding`; `/team` is still the kickoff conversation surface.
- New BullMQ queue for calibration. We reuse the existing kickoff team-run.
- Backwards compatibility with the old strategy-required scan path. The `strategy_not_calibrated` skip branch is deleted, not deprecated.

## Architecture

### High-level changes

1. **Tool layer:** `run_discovery_scan` accepts `inlineQueryCount` and runs scout against inline-generated queries when no calibrated strategy exists. The `strategy_not_calibrated` skipped branch is removed.
2. **Agent layer:** `discovery-scout` AGENT.md gains breadth-spanning instructions in the inline-query branch (broad / medium / specific mix when count ≥ 10). Slow agents (`search-strategist`, `discovery-scout`, `discovery-reviewer`) call a generic `emitProgress` at decision points.
3. **Generic tool-progress infrastructure:**
   - `ToolContext` gains an optional `emitProgress(message, metadata?)` method.
   - `agent-runner` wires this to a Redis publisher that sends `tool_progress` events to `shipflare:events:{userId}:agents`.
   - Sub-agents (strategist inside `calibrate_search_strategy`, scout inside `run_discovery_scan`) inherit the parent context's emitter; events propagate up automatically.
4. **Coordinator playbook:** kickoff order changes to `1 → 3 → 4 → 2 → 3'` with a 0-result fallback that swaps to `1 → 2 → 3 → 4` when first-round scout returns `queued: []`.
5. **Kickoff orchestration:** `team-kickoff.ts` rewrites the goal text to match the new order and explicitly passes `inlineQueryCount: 12` to the first scan.
6. **UI layer:** `TacticalProgressCard` consumes generic `tool_progress` events. Known tool names (`calibrate_search_strategy`, `run_discovery_scan`) get bespoke section UI. Unknown / future tools fall through to a generic activity ticker.
7. **Snapshot endpoint:** `/api/today/progress` returns real calibration state (currently always empty list).

### Out of scope (not touched)

- `/api/onboarding/commit` request/response shape.
- Onboarding wizard's `window.location.href = '/team?from=onboarding'` redirect.
- Daily cron / scheduled scan path — those still use the calibrated strategy.
- Multi-channel kickoff (still primary-only).

## Components

### Tool layer

**`src/tools/RunDiscoveryScanTool/RunDiscoveryScanTool.ts`**

- `inputSchema` adds `inlineQueryCount: z.number().int().min(4).max(20).optional()`.
- The `strategy_not_calibrated` skip branch is **removed**. When `loadStrategy` returns null, the tool calls `runDiscoveryV3` with `presetQueries: undefined` and forwards `inlineQueryCount`.
- Calls `ctx.emitProgress` at two points:
  - Before scout: `'Searching {platform} with {n} queries'`.
  - After bio filter (X only): `'Resolved {n}/{m} bios'`.

**`src/tools/CalibrateSearchTool/CalibrateSearchTool.ts`**

- Removes any tool-specific SSE wrapper. The strategist sub-agent inherits the parent `ToolContext` and uses the generic emitter.

### Agent layer

**`src/tools/AgentTool/agents/discovery-scout/AGENT.md`**

- The `presetQueries: null` branch adds: when `inlineQueryCount >= 10`, deliberately span breadth — 3-4 broad queries (product name, category), 4-5 medium (pain points / value-prop phrasings), 3-4 specific (ICP voice, niche phrasings).
- Input message JSON gains an `inlineQueryCount` field.

**`src/tools/AgentTool/agents/search-strategist/AGENT.md`**

- At the end of each iteration, the strategist calls `emitProgress('Round {n}/{maxTurns} · precision {p} · {move}', { round, maxTurns, precision, sampleSize })`.

**`src/lib/discovery/v3-pipeline.ts`**

- `V3PipelineInput` adds `inlineQueryCount?: number`.
- `buildScoutMessage` forwards it.

### Generic tool-progress infrastructure (new)

**`src/core/tool-system.ts` (or `types.ts`)**

```ts
interface ToolContext {
  // ... existing
  emitProgress?: (message: string, metadata?: Record<string, unknown>) => void;
}
```

**`src/bridge/agent-runner.ts`**

- `createToolContext` builds an `emitProgress` bound to `(userId, toolName, callId)` and delegates to `publishToolProgress`.
- Sub-agent contexts inherit the parent emitter so events propagate (a strategist `emitProgress` call publishes with `toolName: 'calibrate_search_strategy'`, `parentCallId: <coordinator's call id>`).

**`src/lib/sse/publish-tool-progress.ts` (new)**

```ts
interface ToolProgressEvent {
  type: 'tool_progress';
  toolName: string;
  callId: string;
  message: string;
  metadata?: Record<string, unknown>;
  ts: number;
}

async function publishToolProgress(args: {
  userId: string;
  toolName: string;
  callId: string;
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<void>;
```

- Publishes to `shipflare:events:{userId}:agents`.
- Errors are caught, logged, and counted via a dropped-events metric. **Never throws** — UI decoration cannot block the agent loop.

### Playbook & orchestration

**`src/tools/AgentTool/agents/coordinator/AGENT.md`** (kickoff section)

- Step order rewritten: `1 → 3 → 4 → 2 → 3'`.
- Adds the 0-result fallback: "If step 3 returns `queued: []`, skip step 4 and run step 2 next, followed by step 3' (which becomes the first reply-eligible scan). Skip the second `run_discovery_scan` since step 3' is already calibrated."
- Skip-with-message branch updated: if no channels connected, skip steps 2-3-3'-4.

**`src/lib/team-kickoff.ts`**

- `goal` text rewritten:
  - `(1)` content-planner — unchanged.
  - `(3)` `run_discovery_scan({ platform: '${primary}', inlineQueryCount: 12 })`.
  - `(4)` community-manager on top-3 queued threads.
  - `(2)` `calibrate_search_strategy({ platform: '${primary}' })`.
  - `(3')` `run_discovery_scan({ platform: '${primary}' })` — no `inlineQueryCount`, picks up the calibrated strategy.
  - Added: "Skip steps 2-3-3'-4 if no channels are connected." and "If step 3 returns no queued threads, skip step 4 and run step 2 followed by a single calibrated `run_discovery_scan`."

### UI layer

**`src/components/today/tactical-progress-card.tsx`**

- New `tool_progress` event reducer. State keyed by `toolName`, retains latest `message` + `metadata` per tool, deduplicates and reorders by `ts`.
- Routing:
  - `calibrate_search_strategy` → existing `CalibrationSection`. Reads `metadata.round / maxTurns / precision / sampleSize`. The `message` becomes the activity-line under the row. The existing `CalibrationView.maxRounds` field is renamed to `maxTurns` to match the canonical strategist input name (no backward-compat shim).
  - `run_discovery_scan` → new `DiscoverySection`. Renders "Scanning {platform} · {message}" with metadata-driven sub-counts when present (`Resolved 18/22 bios`).
  - Any other `toolName` → bottom `ActivityTicker` row showing the latest message verbatim.
- Visibility: card is visible while ANY of (tactical pending/running/failed, in-flight `tool_progress` for known tool, `from=onboarding` within TTL).
- Dead fields removed: drop the placeholder `tactical_generate_*` references in comments now that they have no producer.

**`src/app/api/today/progress/route.ts`**

- `buildSnapshot` populates `calibration.platforms` from real state. Read MemoryStore `${platform}-search-strategy` entry; if absent → `pending`, if present and recent → `completed`, plus per-platform `precision` from the persisted strategy. Drop the always-empty placeholder.

## Data flow

| T | Event | Surface |
|---|---|---|
| 0s | User clicks Commit | wizard |
| 0-2s | `POST /api/onboarding/commit` returns; client redirects to `/team?from=onboarding` | wizard → /team |
| 2-5s | `/team` SSR calls `ensureKickoffEnqueued`; team-run enqueued with new goal text | /team |
| 5-60s | Step 1: content-planner writes `add_plan_item` × N | /team chat + /today TacticalSection live |
| 60-90s | Step 3: `run_discovery_scan(inlineQueryCount: 12)` runs scout with 12 inline queries; emits `tool_progress` for "Searching X with 12 queries", "Scout judging N threads", "Resolved n/m bios" | /today ActivityTicker + DiscoverySection |
| 90-150s | Step 4: community-manager drafts replies for top-3 queued threads | /today reply cards land |
| 150s-10m | Step 2: `calibrate_search_strategy` runs strategist; emits `tool_progress` per turn `Round n/60 · precision p · {move}` with `metadata.round/maxTurns/precision/sampleSize` | /today CalibrationSection live + ActivityTicker |
| 10-11m | Step 3': second `run_discovery_scan` (no inlineQueryCount) using calibrated strategy; new threads dedupe-insert | /today new reply cards land |
| 11m+5s | Card collapses through 5s grace; `/today` returns to normal | /today |

## Error handling

| Failure | Behavior |
|---|---|
| First-round inline scan returns 0 queueable | Coordinator's 0-result fallback fires: skip step 4, run step 2, then a single calibrated step 3'. `/today` shows EmptyState with "Calibrating to find better matches…" while the calibration row stays visible at top. |
| Calibration fails / strategist throws | Tool throws → coordinator logs `tool_error` → team-run marked failed. CalibrationSection shows "Calibration stalled" and the existing RetryButton (currently mis-wired to `/api/plan/replan`) is removed from the calibration row in this design — there is no automatic retry path in v1. Daily cron scans continue to function via inline-mode fallback (weak queries). Re-running calibration requires manual intervention (a new `/api/calibration/retry` endpoint is an explicit follow-up; out of scope here). The trade-off: a calibration-failure user gets weak results indefinitely until either the follow-up ships or they re-trigger from settings. Acceptable for v1 because failures should be rare; mandatory before this design ships at higher volume. |
| Step 3' re-scan fails | Doesn't affect already-landed drafts. Card collapses without error popup. Pipeline event `discovery_rescan_failed` recorded; daily cron is the natural retry. |
| `emitProgress` Redis publish fails | Caught, counted, logged. Never throws. UI degrades to indeterminate spinner with "Calibrating…" / "Scanning…" headlines. |
| No channels connected | `team-kickoff.ts` goal includes "Skip steps 2-3-3'-4 if no channels". `/today` shows the existing connect-CTA EmptyState. |
| User leaves /today during calibration | Pubsub doesn't replay. On return, `/api/today/progress` snapshot reseeds card from MemoryStore + `team_messages`; ActivityTicker line is empty until next event. |
| Out-of-order events | `tool_progress` carries `ts`. Reducer drops events older than the last seen for that `toolName + callId`. |
| Concurrent kickoff (double tabs / refresh) | `ensureKickoffEnqueued` already idempotent on `(teamId, trigger='kickoff')`. Unchanged. |

## Testing

### Unit tests (vitest)

- `RunDiscoveryScanTool.test.ts`
  - Strategy missing + `inlineQueryCount: 12` → `runDiscoveryV3` receives `presetQueries: undefined, inlineQueryCount: 12`.
  - Strategy present + `inlineQueryCount` passed → `inlineQueryCount` is ignored, calibrated path used.
  - `emitProgress` called before scout and after bio filter (spy on injected ctx).
  - **The skipped/`strategy_not_calibrated` test cases are removed**, not adapted — that branch is gone.
- `CalibrateSearchTool.test.ts`
  - Strategist `runAgent` ctx inherits the parent `emitProgress`. Spy verifies the same callable.
- `team-kickoff.test.ts`
  - Goal text contains, in order: step 1 (content-planner), `run_discovery_scan({ platform: 'x', inlineQueryCount: 12 })`, community-manager dispatch, `calibrate_search_strategy`, second `run_discovery_scan` without `inlineQueryCount`, the 0-result fallback clause, and the no-channels skip clause.
- `publish-tool-progress.test.ts` (new)
  - Happy path: one `emitProgress` → one Redis publish on the right channel with the right payload shape.
  - Redis throws → function does not throw, dropped counter increments.
- `tactical-progress-card.test.tsx`
  - Reducer routes known `toolName` to its section; unknown falls through to ActivityTicker.
  - Out-of-order: older `ts` event for the same `toolName + callId` is discarded.
  - Reducer is exported as a pure function for direct testing.

### Integration tests (vitest, mock LLM)

- `team-kickoff.integration.test.ts` (new or extended)
  - Mock coordinator follows the new playbook → assert `tool_call` order: `add_plan_item × N → run_discovery_scan(inlineQueryCount=12) → community-manager dispatch → calibrate_search_strategy → run_discovery_scan (no inlineQueryCount)`.
  - 0-result fallback: mock scout returns `queued: []` → community-manager not dispatched, `calibrate_search_strategy` runs next, then a single `run_discovery_scan` (calibrated).

### Build gate

- `pnpm tsc --noEmit` clean. The deletion of the `strategy_not_calibrated` branch, the new `ToolContext.emitProgress`, and the `inlineQueryCount` plumbing all touch types; the build must stay green without leaving `// removed` or `_unused` placeholders behind.

### Manual verification

(No Playwright harness in this repo; manual scripts written into the implementation plan.)

1. Reset DB and Redis for a clean user.
2. Run the onboarding wizard end-to-end through commit.
3. On `/team`: verify chief-of-staff dispatches in the new order.
4. Switch to `/today` within 90s: post drafts and reply drafts both land. Top status card shows the calibration row + activity ticker line and updates each strategist turn.
5. Wait through calibration. Step 3' lands new reply cards via dedupe-insert.
6. Card collapses after the 5s grace window.

### Observability

- Every `emitProgress` writes a debug log via `createLogger('tools:tool-progress')`.
- `pipeline_events` records `kickoff_step_completed` per playbook step for cross-run analysis.
- Dropped-progress-event counter exposed as a stub metric (Prometheus / OTel hook can come later).

## Backwards compatibility

None. Per project rule: this design **deletes** the old behavior rather than gating it behind a flag.

- `RunDiscoveryScanTool`'s `strategy_not_calibrated` skip branch — deleted.
- `tactical_generate_*` SSE event names referenced in old comments — deleted.
- `/api/today/progress`'s always-empty `calibration.platforms` placeholder — deleted (now returns real state).
- Old kickoff goal text and old coordinator playbook ordering — replaced verbatim.
- Old test cases that asserted the deleted branches — deleted, not adapted.

## Follow-ups (not in this design)

- `/api/calibration/retry` endpoint + UI affordance for manual recovery from calibration failures. Required before higher-volume rollout. Today's mitigation is inline-mode fallback on subsequent scans.
- Multi-channel kickoff fan-out (Reddit alongside X). The generic tool-progress infrastructure shipped here is forward-compatible with multiple in-flight calibrations; only the kickoff goal text + coordinator playbook need to change.
- Calibration retry on next daily cron when prior calibration is missing or stale. Cleaner than a manual button.

## Open questions

None blocking. Implementation plan can proceed.
