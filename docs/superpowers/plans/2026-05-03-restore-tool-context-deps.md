# Restore Tool-Context Deps + onEvent Forwarding (Phase E orphan fix)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Phase E orphan that broke ~20 domain tools (`query_strategic_path`, `query_plan_items`, `add_plan_item`, `query_team_status`, etc.) and silenced sub-agent / fork-skill event streaming. The team-lead now sees real placeholders in its system prompt (Task 2 of the prior plan) and DOES try to call its tools — but every call fails with `Domain tool context missing required dependency "userId"` because `agent-run.ts:buildPhaseBToolContext` only exposes `callerAgentId`. The deleted `team-run.ts` (commit `4249236`) had a 10-key `get(key)` switch + preloaded platform clients + onEvent forwarding. Restore the missing pieces.

**Architecture:** Two surgical changes inside `src/workers/processors/agent-run.ts`. Task 1 makes `buildPhaseBToolContext` async and wires the standard domain deps (`db`, `userId`, `productId`, `teamId`, `currentMemberId`, `conversationId`, `runId`) plus platform clients via the sanctioned `createTeamPlatformDeps(userId, productId)` helper from `src/lib/platform-deps.ts`. Task 2 wires `onEvent` ctx key + extends the existing `handleStreamEvent` to honor `spawnMeta` for sub-agent attribution, restoring the lost `Task` / `Skill` fork event streaming. No schema changes; one extra Drizzle query per agent-run startup.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), BullMQ, Vitest (mocked DB), `pnpm tsc --noEmit` as the build gate.

**Reproducer (the symptom this plan closes):** Send a message to the team-lead asking for content advice; check worker logs. You'll see:
```
WRN [core:tools] Tool query_strategic_path failed in 2ms: Domain tool context missing required dependency "userId". The team-run worker injects userId/productId/db; ensure this tool is only called from a team run.
WRN [core:tools] Tool query_plan_items failed in 2ms: Domain tool context missing required dependency "userId". ...
```

---

## Pre-flight context (read once)

- The current broken function: `src/workers/processors/agent-run.ts:150-164` (`buildPhaseBToolContext`).
- The call site: `src/workers/processors/agent-run.ts:796` (`const ctx = buildPhaseBToolContext(controller, agentId);`). Will become `await` after Task 1.
- The deps contract every domain tool reads: `src/tools/context-helpers.ts` (`requireDep` + `tryGet`).
- The deleted reference impl (use as a guide, NOT a copy-paste — Phase E architecture differs):
  ```
  git show 4249236 -- src/workers/processors/team-run.ts | sed -n '720,770p'
  ```
- Sanctioned platform-client helper (CLAUDE.md "Architecture Rule 5"): `createTeamPlatformDeps(userId, productId | null)` from `src/lib/platform-deps.ts:157`. Returns `{ xaiClient?, xClient?, redditClient?, memoryStore? }` keyed by enabled platforms. Routes / processors MUST go through this helper — do NOT call `XClient.fromChannel` etc. directly.
- `teams` schema: `src/lib/db/schema/team.ts:34-55` — text PK, `userId` (NOT NULL FK), `productId` (nullable FK).
- The Phase E hot-fix already resolved `leadConversationId` (line 402) and `leadRequestId` (search the file) — Task 1 reuses them, doesn't re-resolve.
- Sub-agent event flow: `src/tools/AgentTool/AgentTool.ts:561-575` (Task) and `src/tools/SkillTool/SkillTool.ts:102-115` (Skill) both read `ctx.get<SpawnCallbacks['onEvent'] | null>('onEvent')` and forward to the spawned/forked runAgent. When the key returns null, the spawn runs silently (graceful degrade — that's the current state).
- spawnMeta type: `src/core/types.ts:117-131` — `{ parentToolUseId, fromMemberId: string | null, agentName }`. Stamped onto child events by `wrapOnEventWithSpawnMeta` inside the Task tool.
- handleStreamEvent (the closure I extended in Task 1 of the prior plan): `src/workers/processors/agent-run.ts:485-695`. Currently uses `row.memberId` for `fromMemberId` on every persisted row. Task 2 below makes it prefer `event.spawnMeta?.fromMemberId` when present.
- Build gate: `pnpm tsc --noEmit --pretty false` exit 0. Vitest uses `isolatedModules` so it does NOT type-check; a green test run is not sufficient.
- Saved feedback memory: keep two-stage opus review per task; launch gap-audit at end; refactor freely (no `-v2` aliasing).

---

## Task 1: Wire domain deps + platform clients into the agent-run tool context

**Files:**
- Modify: `src/workers/processors/agent-run.ts:150-164` (`buildPhaseBToolContext` — make async, accept the team row + conversationId + runId, expose all domain keys + platform deps).
- Modify: `src/workers/processors/agent-run.ts:796` (call site — `await`, pass new args).
- Test (extend): `src/workers/processors/__tests__/agent-run.test.ts` — three new tests.

### Task 1 spec

Rewrite `buildPhaseBToolContext` to:

```ts
async function buildPhaseBToolContext(
  controller: AbortController,
  agentId: string,
  args: {
    teamId: string;
    userId: string;
    productId: string | null;
    memberId: string;
    conversationId: string | null;
    runId: string;
  },
): Promise<ToolContext> {
  // Preload all platform clients for this user/product so domain tools
  // (xClient.search, redditClient.fetchThread, etc.) can pull them off the
  // ctx without each tool spinning up its own client. Sanctioned per
  // CLAUDE.md "Architecture Rule 5".
  const platformDeps = await createTeamPlatformDeps(args.userId, args.productId);

  return {
    abortSignal: controller.signal,
    get<V>(key: string): V {
      // Platform clients win over the static switch (matches deleted
      // team-run.ts precedent: `if (key in platformDeps) return ...`).
      if (key in platformDeps) {
        return (platformDeps as Record<string, unknown>)[key] as V;
      }
      switch (key) {
        case 'db':                return db as unknown as V;
        case 'teamId':            return args.teamId as unknown as V;
        case 'userId':            return args.userId as unknown as V;
        case 'productId':         return args.productId as unknown as V;
        case 'currentMemberId':   return args.memberId as unknown as V;
        case 'conversationId':    return args.conversationId as unknown as V;
        case 'runId':             return args.runId as unknown as V;
        case 'callerAgentId':     return agentId as unknown as V;
        // Phase D Sleep + future signaling keys keep working unchanged.
        default:
          throw new Error(`Missing dependency: ${key}`);
      }
    },
  };
}
```

At the call site (currently line 796):

```ts
// Phase E hot-fix (Phase E orphan): the team-run worker used to load
// userId/productId/teamId/platformDeps into ctx. agent-run never did.
// Result: every domain tool throws "Domain tool context missing
// required dependency 'userId'" the moment it runs. Fix: load the
// team row once at startup, then build a context that exposes the
// standard domain keys + platform clients.
const teamRows = await db
  .select({ id: teams.id, userId: teams.userId, productId: teams.productId })
  .from(teams)
  .where(eq(teams.id, row.teamId))
  .limit(1);
if (teamRows.length === 0) {
  throw new Error(`agent-run ${agentId}: team ${row.teamId} not found`);
}
const team = teamRows[0]!;

const ctx = await buildPhaseBToolContext(controller, agentId, {
  teamId: team.id,
  userId: team.userId,
  productId: team.productId,
  memberId: row.memberId,
  conversationId: isLead ? leadConversationId : null,
  runId: isLead ? leadRequestId : agentId,
});
```

**Imports to add at the top of `agent-run.ts`:**
```ts
import { teams } from '@/lib/db/schema/team';
import { createTeamPlatformDeps } from '@/lib/platform-deps';
```
(`teams` may already be imported via the barrel — check first; do not duplicate.)

### Task 1 steps

- [ ] **Step 1: Write failing tests** in `src/workers/processors/__tests__/agent-run.test.ts`:

  1. `'tool ctx exposes db / userId / productId / teamId / currentMemberId / conversationId / runId'` — drive the worker through `processAgentRun`; capture the `ctx` argument passed to `runAgent` (it's positional arg 3); assert each `ctx.get(key)` returns the expected value seeded by the test fixtures (e.g. `userId` matches the mocked team row's userId).
  2. `'tool ctx exposes platform clients from createTeamPlatformDeps'` — mock `createTeamPlatformDeps` to return `{ xClient: 'fake-x', redditClient: 'fake-r' }`; assert `ctx.get('xClient') === 'fake-x'` and `ctx.get('redditClient') === 'fake-r'`.
  3. `'fails the run with a clear error when team row is missing'` — mock the teams query to return `[]`; assert the run is marked failed with `summary` containing `team <id> not found`. (Use the existing `markFailed` mock in the test file.)

  ```ts
  // Sketch — implementer fills in to match the file's existing test plumbing:
  it('tool ctx exposes db / userId / productId / teamId / currentMemberId / conversationId / runId', async () => {
    let capturedCtx: ToolContext | undefined;
    runAgentMock.mockImplementationOnce(async (_cfg, _prompt, ctx) => {
      capturedCtx = ctx;
      return makeFakeRunResult();
    });
    seedTeamRow({ id: 'team-1', userId: 'user-7', productId: 'prod-3' });
    seedAgentRow({ id: 'a-1', teamId: 'team-1', memberId: 'mem-9' });
    await processAgentRun({ data: { agentId: 'a-1' } } as any);
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.get<string>('userId')).toBe('user-7');
    expect(capturedCtx!.get<string>('productId')).toBe('prod-3');
    expect(capturedCtx!.get<string>('teamId')).toBe('team-1');
    expect(capturedCtx!.get<string>('currentMemberId')).toBe('mem-9');
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**

  Run: `pnpm vitest run src/workers/processors/__tests__/agent-run.test.ts`
  Expected: the three new tests fail (current `buildPhaseBToolContext` throws on every key except `callerAgentId`; team-row query is absent).

- [ ] **Step 3: Implement the changes per the spec above.**

  Make `buildPhaseBToolContext` async, add the `args` parameter, wire all the keys, change the call site to load the team row + `await`. Add the two imports.

- [ ] **Step 4: Run tests to verify they pass**

  Run: `pnpm vitest run src/workers/processors/__tests__/agent-run.test.ts`
  Expected: PASS — all prior tests + the three new ones green.

- [ ] **Step 5: Type-check the build gate**

  Run: `pnpm tsc --noEmit --pretty false`
  Expected: exit code 0.

- [ ] **Step 6: Commit**

  ```bash
  git add src/workers/processors/agent-run.ts src/workers/processors/__tests__/agent-run.test.ts
  git commit -m "$(cat <<'EOF'
  fix(agent-run): restore domain tool deps in ToolContext (Phase E orphan)

  Phase E deleted team-run.ts, which had a 10-key get(key) switch +
  preloaded platform clients. agent-run.ts only exposed callerAgentId,
  so every domain tool (~20 of them) threw "Missing required dependency
  'userId'" on first call. The team-lead's strategy / plan / status
  queries all failed silently and the agent fell back to "DB context
  not injected" excuses. Wire db, userId, productId, teamId,
  currentMemberId, conversationId, runId, plus platform clients via
  the sanctioned createTeamPlatformDeps helper.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 2: Wire `onEvent` ctx key + spawnMeta-aware attribution in handleStreamEvent

**Files:**
- Modify: `src/workers/processors/agent-run.ts:150-164` (extend the same `get(key)` switch built in Task 1 with an `onEvent` case).
- Modify: `src/workers/processors/agent-run.ts:485-695` (`handleStreamEvent` — honor `event.spawnMeta?.fromMemberId` for `tool_call` / `tool_result` / `agent_text` row attribution).
- Test (extend): `src/workers/processors/__tests__/agent-run.test.ts` — two new tests.

### Task 2 spec

**Part A — expose `onEvent` on the ctx.**

`src/tools/AgentTool/AgentTool.ts:573` and `src/tools/SkillTool/SkillTool.ts:113` both call `ctx.get<SpawnCallbacks['onEvent'] | null>('onEvent')` and forward the returned function into the spawned runAgent / forked skill. When the ctx returns null/throws, sub-agents and skill forks run "quietly" — their tool events and assistant text never reach the lead's handleStreamEvent, so they're invisible in the founder UI even though my Task 1 (prior plan) handles the lead's own events.

Fix: extend the `get(key)` switch built in Task 1 to support `case 'onEvent':` returning the same `handleStreamEvent` function passed to the outer `runAgent` call. Because handleStreamEvent is declared as a `const` later in the same processAgentRun scope, we need to either:

- **Option A** (preferred): wrap `onEvent` in a holder object so the ctx returns `holder.fn` and we set `holder.fn = handleStreamEvent` after both are constructed. Mirrors the deleted team-run.ts's `onEventHolder` pattern (line 752).
- **Option B**: declare `handleStreamEvent` BEFORE the call to `buildPhaseBToolContext` so it's in scope.

Go with **Option A** — it preserves the current top-down code order in the file (handleStreamEvent below ctx construction) and matches the deleted reference. Concretely:

```ts
// Just above the buildPhaseBToolContext invocation:
const onEventHolder: { fn: ((event: StreamEvent) => void | Promise<void>) | null } = { fn: null };

const ctx = await buildPhaseBToolContext(controller, agentId, {
  teamId: team.id,
  userId: team.userId,
  productId: team.productId,
  memberId: row.memberId,
  conversationId: isLead ? leadConversationId : null,
  runId: isLead ? leadRequestId : agentId,
  onEventHolder,  // NEW arg
});

// ... after handleStreamEvent is declared:
onEventHolder.fn = handleStreamEvent;
```

And inside `buildPhaseBToolContext`'s switch:
```ts
case 'onEvent':
  return onEventHolder.fn as unknown as V;
```

The `null` return when called before assignment is fine — Task / SkillTool's null check will skip forwarding. In practice, the lead loop is single-threaded so nobody calls `ctx.get('onEvent')` until handleStreamEvent has already been assigned (Task tool fires inside runAgent, which is invoked AFTER the holder is wired).

**Part B — spawnMeta-aware attribution in handleStreamEvent.**

When a sub-agent spawned via Task fires `tool_start` / `tool_done` / `assistant_text_stop`, the Task tool wraps `onEvent` with `wrapOnEventWithSpawnMeta(parentOnEvent, spawnMeta)` so every child event carries `spawnMeta`. The current handleStreamEvent (from Task 1 of the prior plan) hard-codes `fromMemberId: row.memberId` (the lead's member). This stamps child rows with the WRONG member.

Fix: prefer `event.spawnMeta?.fromMemberId` when present, fall back to `row.memberId`. Apply to all three insert sites in handleStreamEvent:

1. The `assistant_text_stop` insert (line ~530 area).
2. The new `tool_call` insert (added in Task 1 of prior plan).
3. The new `tool_result` insert (added in Task 1 of prior plan).

Define a small helper near the top of handleStreamEvent:
```ts
const resolveFromMemberId = (event: StreamEvent): string => {
  if ('spawnMeta' in event && event.spawnMeta?.fromMemberId) {
    return event.spawnMeta.fromMemberId;
  }
  return row.memberId;
};
```

And replace each `fromMemberId: row.memberId,` site with `fromMemberId: resolveFromMemberId(event),`.

Also store `spawnMeta` in `metadata` for tool rows (so the UI's existing delegation-card can match the child rows back to the parent Task's tool_use_id):
```ts
metadata: {
  // ... existing fields ...
  ...(event.spawnMeta ? { parent_tool_use_id: event.spawnMeta.parentToolUseId, agent_name: event.spawnMeta.agentName } : {}),
}
```

### Task 2 steps

- [ ] **Step 1: Write failing tests** in `src/workers/processors/__tests__/agent-run.test.ts`:

  1. `'tool ctx exposes onEvent that fires handleStreamEvent for child events'` — capture `ctx`, then call `ctx.get('onEvent')(...)` with a synthesized `tool_start` event carrying `spawnMeta: { fromMemberId: 'child-mem', agentName: 'discovery-agent', parentToolUseId: 'toolu_parent_1' }`. Assert a `tool_call` row was inserted with `fromMemberId: 'child-mem'` and `metadata.parent_tool_use_id: 'toolu_parent_1'`.
  2. `'handleStreamEvent uses spawnMeta.fromMemberId when present'` — same test setup but drive the runAgentMock to fire the spawnMeta-tagged event directly (skip the manual ctx.get). Assert the inserted row's `fromMemberId === 'child-mem'`, NOT the lead's memberId.

- [ ] **Step 2: Run tests to verify they fail**

  Run: `pnpm vitest run src/workers/processors/__tests__/agent-run.test.ts`
  Expected: FAIL — current code returns lead's `row.memberId` regardless of spawnMeta; `ctx.get('onEvent')` throws.

- [ ] **Step 3: Implement Part A (onEvent ctx key + holder pattern).**

  Add the `onEventHolder` declaration above the `buildPhaseBToolContext` call, pass it through the args, add the `case 'onEvent':` switch arm, and assign `onEventHolder.fn = handleStreamEvent;` AFTER `handleStreamEvent` is declared.

- [ ] **Step 4: Implement Part B (resolveFromMemberId helper + spawnMeta in metadata).**

  Add the `resolveFromMemberId` helper at the top of `handleStreamEvent`. Replace the three `fromMemberId: row.memberId,` sites. Conditionally spread spawnMeta into the metadata for tool_call / tool_result inserts (assistant_text rows: also include parentToolUseId in metadata if spawnMeta present, so the UI delegation tree can nest the text correctly).

- [ ] **Step 5: Run tests to verify they pass**

  Run: `pnpm vitest run src/workers/processors/__tests__/agent-run.test.ts`
  Expected: PASS — all prior tests + the two new ones green. The Task 1 (prior plan) tests for tool_call / tool_result persistence should still pass because they don't pass spawnMeta — the helper returns `row.memberId` in that case.

- [ ] **Step 6: Type-check the build gate**

  Run: `pnpm tsc --noEmit --pretty false`
  Expected: exit code 0.

- [ ] **Step 7: Run a wider regression sweep**

  Run: `pnpm vitest run src/tools/SkillTool/__tests__/SkillTool.integration.test.ts src/tools/AgentTool/__tests__`
  Expected: all green (especially the SkillTool fork-mode `'forwards parent onEvent from ctx to runAgent'` test, which was the long-standing regression guard for this exact wiring).

- [ ] **Step 8: Commit**

  ```bash
  git add src/workers/processors/agent-run.ts src/workers/processors/__tests__/agent-run.test.ts
  git commit -m "$(cat <<'EOF'
  fix(agent-run): wire onEvent ctx key + spawnMeta-aware attribution

  Phase E silently dropped the onEvent ctx key that AgentTool /
  SkillTool read for sub-agent + fork-skill event forwarding. Without
  it, child runAgent / fork events vanished and the lead's UI never
  saw nested tool calls. Restore the holder-pattern wiring (matches
  deleted team-run.ts) and extend handleStreamEvent to honor
  spawnMeta.fromMemberId so child rows are attributed to the spawned
  member, not the lead. Existing SkillTool fork-mode regression test
  guards this from happening again.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Self-review checklist (controller runs after writing the plan)

- [x] **Spec coverage** — both halves (deps + onEvent/attribution) have dedicated tasks with concrete file:line refs and test specs.
- [x] **Placeholder scan** — every step has executable code, no "implement appropriate handling" hand-waves.
- [x] **Type consistency** — `args` interface for `buildPhaseBToolContext` declared once and matched in the call-site update; `onEventHolder` shape consistent across both files.
- [x] **Build gate** — every implementing task ends with `pnpm tsc --noEmit --pretty false` (per saved memory: vitest's `isolatedModules` does not type-check).
- [x] **CLAUDE.md compliance** — uses `createTeamPlatformDeps` (sanctioned helper); does NOT call `XClient.fromChannel` etc. directly. No new platform `if (platform === 'x')` branches.
- [x] **Reuses prior work** — Task 2's `resolveFromMemberId` extends Task 1 (prior plan)'s already-shipped `handleStreamEvent` in-place, not a fork.
- [x] **No "fix later" debt** — `onEvent` ctx key uses the holder pattern that matches deleted team-run.ts so future maintainers see the precedent.
