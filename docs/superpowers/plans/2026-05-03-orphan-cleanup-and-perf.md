# Phase E Orphan Cleanup + Lead-Wake Perf

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the long-tail set of pre-existing orphans + documented MEDIUM/LOW findings flagged by code reviews and the gap audit during the 2026-05-03 work session. Three logical bundles by area; each bundle is one commit with full test coverage.

**Architecture:** Sequential tasks in one worktree (the changes mostly cluster in `src/workers/processors/agent-run.ts` and `src/lib/team/system-prompt-context.ts`, so parallel worktrees would just create merge conflicts). Same two-stage opus review per task. Final gap audit before merge.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), BullMQ, Vitest, `pnpm tsc --noEmit` as the build gate.

---

## What's IN scope

**Task 1 — correctness orphans (3 items):**
- `callerRole` ctx key — `SendMessageTool.ts:254` and `TaskStopTool.ts:120` both fail-closed when missing → lead currently can't `TaskStop` teammates from inside its own loop. Pre-existing (deleted team-run.ts also missed it).
- `SkillTool.ts:118-120` forwards raw `onEventFn` without `wrapOnEventWithSpawnMeta` → fork-skill events attribute to the lead, not the spawned specialist.
- SSE `from` field for spawnMeta-tagged events — `agent-run.ts` lead-path SSE publish still uses `row.memberId` even when the durable row correctly attributes via `resolveFromMemberId`. Live envelope mismatch fixes itself on refresh, but creates a 1-3 second visual stutter as the founder UI snaps from "lead" to "specialist".

**Task 2 — lead-wake perf (3 items):**
- `loadSystemPromptContext` runs 7 sequential queries → parallelize with `Promise.all` (everything after the team row is independent).
- N+1 on roster build (`for…await resolveAgent`) → `Promise.all`.
- Duplicate teams SELECT — `loadSystemPromptContext` and `agent-run.ts` both load the same `teams` row 13 lines apart → hoist into one query that both consume.

**Task 3 — UX + style polish (3 items):**
- `statusBreakdown === ''` and `teamRoster === ''` render bare `B:` / `T:` in the lead's prompt → default to `'(none)'`.
- Magic `4000` truncation limit in `agent-run.ts` → extract to `src/lib/limits.ts` as `TOOL_RESULT_TRUNCATION_LIMIT` so the activity-log renderer can reference the same constant.
- Drop `as Array<{...}>` casts in `system-prompt-context.ts` (8 sites) — let Drizzle infer.

## What's OUT of scope (intentional deferrals)

- **`createTeamPlatformDeps` memoization** — flagged as MEDIUM but needs an invalidation strategy when the user connects/disconnects a channel mid-session. Requires a separate brainstorm; do not bolt on a naive cache.
- **Test stubs using `args[7]` positionally** — flagged LOW; test-only sturdiness, not user-facing. Defer until we touch the affected test file for unrelated reasons.

---

## Pre-flight context (read once)

- The two prior PRs that landed the foundation:
  - `8da3146` (placeholder substitution + `loadSystemPromptContext` introduced)
  - `018f885` + `6bb747b` (Phase E orphan fix — domain deps + onEvent + spawnMeta attribution)
- The deleted reference for `callerRole` shape:
  ```
  git show 4249236 -- src/workers/processors/team-run.ts | grep -n "callerRole\|isLead"
  ```
  → No callerRole in deleted code either; this orphan PRE-DATES Phase E. The `SendMessageTool` lead-only check was added later and never had its ctx wiring done.
- `SendMessageTool.ts:254` and `TaskStopTool.ts:120` use `tryGet<string>(ctx, 'callerRole')` → fall through to `null` → fail-closed.
- `wrapOnEventWithSpawnMeta` lives in `src/tools/AgentTool/AgentTool.ts:305-335` and is exported from there. The Task tool already uses it; SkillTool currently does not.
- `loadSystemPromptContext` lives in `src/lib/team/system-prompt-context.ts`. Its current shape: 7 awaited queries one-after-another. After parallelization, the team row still needs to be loaded first (its `userId` / `productId` are inputs to the other 6).
- The hoist for duplicate teams SELECT: `loadSystemPromptContext` already loads `team` internally. Make it return `{ ctx: SystemPromptContext, team: { id, userId, productId } }` and have `agent-run.ts` consume the `team` object instead of running its own SELECT. (Backward-compat note: the call site in `agent-run.ts` is the ONLY caller of `loadSystemPromptContext`.)
- `TOOL_RESULT_TRUNCATION_LIMIT` should land in `src/lib/limits.ts`. If that file doesn't exist yet, create it. If it does, append.
- Build gate: `pnpm tsc --noEmit --pretty false` exit 0. Vitest does NOT type-check (`isolatedModules`).

---

## Task 1: Correctness orphans (`callerRole` + `SkillTool` spawnMeta + SSE-from attribution)

**Files:**
- Modify: `src/workers/processors/agent-run.ts` — add `callerRole` to `PhaseBToolContextArgs` + switch case + call-site wiring; SSE-from uses `resolveFromMemberId(event)` for the publish payload's `from` field.
- Modify: `src/tools/SkillTool/SkillTool.ts` — wrap forwarded `onEventFn` with `wrapOnEventWithSpawnMeta` so fork-skill events carry attribution.
- Modify: `src/tools/AgentTool/AgentTool.ts` — verify `wrapOnEventWithSpawnMeta` is exported (or add the export). Make sure `SkillTool` can import it.
- Test: extend `src/workers/processors/__tests__/agent-run.test.ts`, `src/tools/SkillTool/__tests__/SkillTool.integration.test.ts`.

### Task 1 spec

**Part A — `callerRole` ctx key.**

In `agent-run.ts`:
- Extend `PhaseBToolContextArgs` with `role: 'lead' | 'member'`.
- Add `case 'callerRole': return args.role as unknown as V;` to the switch.
- At the call site, pass `role: isLead ? 'lead' : 'member'`.

Verify the consumers:
- `SendMessageTool.ts:254`: reads via `tryGet<string>(ctx, 'callerRole')`. After this fix, lead-originated messages return `'lead'` and pass the lead-only checks.
- `TaskStopTool.ts:120`: same. After this fix, lead can `TaskStop` teammates from inside its loop.

**Part B — `SkillTool` wraps onEvent with spawnMeta.**

In `src/tools/SkillTool/SkillTool.ts:102-115` (the block that reads `onEventFn` from `ctx`), after the `typeof fromCtx === 'function'` check, wrap it:

```ts
import { wrapOnEventWithSpawnMeta } from '@/tools/AgentTool/AgentTool';
import { resolveSpecialistMemberId } from '@/tools/AgentTool/...'; // wherever it lives

// Inside the SkillTool fork mode:
const memberId = await resolveSpecialistMemberId(ctx, args.skill_name);
const wrapped = wrapOnEventWithSpawnMeta(onEventFn, {
  parentToolUseId: ctx.toolUseId, // or whatever the tool exposes
  fromMemberId: memberId,
  agentName: args.skill_name,
});
// pass `wrapped` to runForkSkill instead of `onEventFn`
```

If `wrapOnEventWithSpawnMeta` is currently file-local in `AgentTool.ts`, add an `export` keyword to its declaration. If `resolveSpecialistMemberId` is also file-local, decide whether to export or to inline a similar lookup inside `SkillTool.ts`. **Implementer judgment call** — pick whichever keeps the dep graph cleanest. If exporting `resolveSpecialistMemberId` requires moving it out of `AgentTool.ts` to keep the boundary clean, do that.

**Part C — SSE-from attribution.**

In `agent-run.ts:handleStreamEvent`, the lead-path SSE publish for `tool_call` / `tool_result` rows currently sends:
```ts
from: row.memberId,
```

Change to:
```ts
from: resolveFromMemberId(event),
```

Also update the `assistant_text_stop` SSE publish (around the line that says `from: row.memberId,` after the `agent_text` insert) to use `resolveFromMemberId(event)` for consistency.

The durable rows already use `resolveFromMemberId` (Task 2 of the prior plan). This brings the live envelope into agreement with the persisted truth.

### Task 1 steps

- [ ] **Step 1: Write failing tests** (extend existing test files):

  In `agent-run.test.ts` add:
  1. `'tool ctx exposes callerRole=lead for lead role and member for teammate role'` — drive two runs (one with `def.role === 'lead'`, one with `'member'`), capture ctx, assert `ctx.get('callerRole') === 'lead'` / `'member'` accordingly.
  2. `'lead-path SSE publish uses spawnMeta.fromMemberId when present'` — fire a tool_start event with spawnMeta; assert the published payload's `from` field matches `spawnMeta.fromMemberId`, NOT `row.memberId`.

  In `SkillTool.integration.test.ts` add:
  3. `'fork mode: wraps parent onEvent with spawnMeta so child events attribute to the fork specialist'` — drive a fork-skill call where the parent ctx exposes a captured `onEventFn`; fire a synthesized tool_start through the wrapped callback; assert the event delivered to the parent's onEvent has `spawnMeta.fromMemberId === <fork member id>` and `spawnMeta.agentName === <skill name>`.

- [ ] **Step 2: Run tests to verify they fail**

  Run: `pnpm vitest run src/workers/processors/__tests__/agent-run.test.ts src/tools/SkillTool/__tests__/SkillTool.integration.test.ts`
  Expected: the three new tests fail.

- [ ] **Step 3: Implement Part A (callerRole).**

  Add the `role` field to `PhaseBToolContextArgs`, add the `case 'callerRole':` arm, thread `role: isLead ? 'lead' : 'member'` through the call site.

- [ ] **Step 4: Implement Part B (SkillTool wraps onEvent).**

  Export `wrapOnEventWithSpawnMeta` (and `resolveSpecialistMemberId` if reusing) from `AgentTool.ts`. Update `SkillTool.ts` to wrap before forwarding.

- [ ] **Step 5: Implement Part C (SSE-from uses resolveFromMemberId).**

  Update the three SSE publish payloads in `agent-run.ts` (assistant_text_stop, tool_call, tool_result) to use `resolveFromMemberId(event)` for the `from` field.

- [ ] **Step 6: Run tests to verify they pass**

  Run: `pnpm vitest run src/workers/processors/__tests__/agent-run.test.ts src/tools/SkillTool/__tests__/SkillTool.integration.test.ts src/tools/AgentTool/__tests__`
  Expected: all green, including all prior tests.

- [ ] **Step 7: Type-check**

  Run: `pnpm tsc --noEmit --pretty false`
  Expected: exit 0.

- [ ] **Step 8: Commit**

  ```bash
  git add src/workers/processors/agent-run.ts \
          src/workers/processors/__tests__/agent-run.test.ts \
          src/tools/SkillTool/SkillTool.ts \
          src/tools/SkillTool/__tests__/SkillTool.integration.test.ts \
          src/tools/AgentTool/AgentTool.ts
  git commit -m "$(cat <<'EOF'
  fix(agent-run): close pre-existing orphans (callerRole + SkillTool spawnMeta + SSE-from)

  Three pre-existing attribution holes the gap audit surfaced:
  - callerRole ctx key was never wired, so the lead's TaskStop /
    lead-only SendMessage paths fail-closed. Add the case to the
    ToolContext switch and pass the lead/member role from the worker.
  - SkillTool forwarded onEvent without wrapOnEventWithSpawnMeta, so
    fork-skill events attributed to the lead instead of the spawned
    specialist. Wrap before forward.
  - lead-path SSE publish used row.memberId for the `from` field even
    when the durable row correctly attributed via resolveFromMemberId.
    Bring the live envelope into agreement with the persisted truth so
    the founder UI doesn't snap from lead to specialist on refresh.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 2: Lead-wake perf (`loadSystemPromptContext` parallelization + hoist team SELECT)

**Files:**
- Modify: `src/lib/team/system-prompt-context.ts` — parallelize 7 queries with `Promise.all`; parallelize `resolveAgent` calls in roster builder; change return type to `{ ctx: SystemPromptContext, team: { id, userId, productId } }`.
- Modify: `src/workers/processors/agent-run.ts` — replace the inline `select({ id, userId, productId }) from teams` with the team object from `loadSystemPromptContext`'s return value. Remove the duplicate query.
- Test: extend `src/lib/team/__tests__/system-prompt-context.test.ts` and `src/workers/processors/__tests__/agent-run.test.ts`.

### Task 2 spec

**Part A — parallelize `loadSystemPromptContext`.**

Current shape (~7 sequential awaits): team → product → strategicPath → channels → planItems → user → teamMembers (+ N resolveAgent inside the for-loop).

After:
1. First, `await` the team row (its `userId` / `productId` are inputs to the rest).
2. Then `Promise.all` the 6 dependent queries: product, strategicPath, channels, planItems, user, teamMembers.
3. After teamMembers settles, `Promise.all` the `resolveAgent(...)` calls for the roster.
4. Finally compose the `SystemPromptContext` from the resolved values.

Preserve every behavior (defaults, error handling, throw on missing team) — purely a re-arrangement. Tests should not need changes EXCEPT to verify parallelism (an integration sniff test that mocks `db.select` to track call ordering and asserts non-team queries fire concurrently).

**Part B — change return type to expose team row.**

Change `loadSystemPromptContext` signature:
```ts
// Before:
export async function loadSystemPromptContext(args): Promise<SystemPromptContext>;
// After:
export async function loadSystemPromptContext(args): Promise<{
  ctx: SystemPromptContext;
  team: { id: string; userId: string; productId: string | null };
}>;
```

In `agent-run.ts`:
1. Replace the standalone `select({ id, userId, productId }) from teams ... where teamId` with the team object returned by `loadSystemPromptContext`.
2. Update the call site:
   ```ts
   const { ctx: promptCtx, team } = await loadSystemPromptContext({ teamId: row.teamId, db });
   ```
3. Use `team.id / team.userId / team.productId` for the subsequent `buildPhaseBToolContext` args.
4. Keep the `team-not-found` throw inside `loadSystemPromptContext` (it already throws there) — just delete the duplicate one in `agent-run.ts`.

### Task 2 steps

- [ ] **Step 1: Write failing tests**

  Add to `system-prompt-context.test.ts`:
  1. `'loadSystemPromptContext returns both ctx and team object'` — fixture happy path; assert returned object has `.ctx` and `.team` with `id / userId / productId`.

  Add to `agent-run.test.ts`:
  2. `'agent-run does not run a separate teams SELECT — reuses team object from loadSystemPromptContext'` — track `db.select(...).from(teams).where(...)` call count via the existing `teamSelectChain` mock; assert ONLY ONE call lands per agent-run startup (currently TWO).

  Optional sniff test for parallelism — track query call ordering. Skip if the existing test infrastructure can't observe it cleanly; a behavioral test of "same end-state" is fine.

- [ ] **Step 2: Run tests to verify they fail**

  Run: `pnpm vitest run src/lib/team/__tests__/system-prompt-context.test.ts src/workers/processors/__tests__/agent-run.test.ts`
  Expected: the new tests fail.

- [ ] **Step 3: Implement Part A (parallelize)** in `system-prompt-context.ts`.

  Restructure the function body. Use `Promise.all` for the 6 post-team queries; collect results positionally. Use `Promise.all(memberRows.map(m => resolveAgent(m.agentType).catch(err => { log.warn...; return null })))` for the roster, then `.filter((d): d is AgentDefinition => d !== null)`.

- [ ] **Step 4: Implement Part B (return shape change)** in `system-prompt-context.ts` AND `agent-run.ts` simultaneously (the two files must change in lockstep so the build stays green).

- [ ] **Step 5: Run tests to verify they pass**

  Run: `pnpm vitest run src/lib/team/__tests__/system-prompt-context.test.ts src/workers/processors/__tests__/agent-run.test.ts`
  Expected: all green; the 2 new tests + all prior ones.

- [ ] **Step 6: Type-check**

  Run: `pnpm tsc --noEmit --pretty false`
  Expected: exit 0.

- [ ] **Step 7: Commit**

  ```bash
  git add src/lib/team/system-prompt-context.ts \
          src/lib/team/__tests__/system-prompt-context.test.ts \
          src/workers/processors/agent-run.ts \
          src/workers/processors/__tests__/agent-run.test.ts
  git commit -m "$(cat <<'EOF'
  perf(team-lead): parallelize loadSystemPromptContext + hoist duplicate teams SELECT

  Lead wakes per founder DM and per task_notification; loadSystemPromptContext
  was running 7 sequential queries + an N+1 over team_members. Parallelize
  the 6 post-team queries and the roster resolveAgent calls with Promise.all,
  and have loadSystemPromptContext return the team row so agent-run.ts can
  drop its duplicate SELECT.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 3: UX defaults + style polish

**Files:**
- Create: `src/lib/limits.ts` (or modify if it exists) — export `TOOL_RESULT_TRUNCATION_LIMIT = 4000`.
- Modify: `src/workers/processors/agent-run.ts` — replace local `4000` with the new constant.
- Modify: `src/lib/team/system-prompt-context.ts` — empty-string defaults to `'(none)'`; drop `as Array<{...}>` casts (8 sites).
- Test: extend `src/lib/team/__tests__/system-prompt-context.test.ts`.

### Task 3 spec

**Part A — empty-string defaults.**

In `system-prompt-context.ts`:
- Where `statusBreakdown` is currently `''` when `itemCount === 0`: return `'(none)'`.
- Where `teamRoster` is currently `''` when no resolvable members exist: return `'(none yet — team_members table is empty)'`.

Update test expectations accordingly. The existing `'sane defaults on empty DB'` test should now assert `'(none)'` not `''`.

**Part B — extract truncation constant.**

Create `src/lib/limits.ts`:
```ts
/**
 * Maximum length (in characters) of `team_messages.content` for a
 * `tool_result` row. The full output is preserved in metadata.tool_output;
 * this cap keeps the displayed text reasonable in the activity log
 * without paying the full cost of large JSON tool results in the row.
 */
export const TOOL_RESULT_TRUNCATION_LIMIT = 4000;
```

Replace the local `const TRUNC_LIMIT = 4000;` in `agent-run.ts:handleStreamEvent` with an import + use of `TOOL_RESULT_TRUNCATION_LIMIT`.

**Part C — drop `as Array<{...}>` casts.**

In `system-prompt-context.ts`, find every `as Array<{...}>` after a Drizzle `.select(...).from(...)...await` chain. Drop the cast — Drizzle's inferred return type is correct. Verify with `pnpm tsc --noEmit --pretty false` that no type errors surface.

### Task 3 steps

- [ ] **Step 1: Write failing tests**

  In `system-prompt-context.test.ts`:
  1. Update the existing `'sane defaults on empty DB'` test: assert `statusBreakdown === '(none)'` and `teamRoster === '(none yet — team_members table is empty)'`.
  2. Add `'TOOL_RESULT_TRUNCATION_LIMIT exports 4000 chars'` (in a new test file or appended to a sensible existing one) — basic export sanity.

- [ ] **Step 2: Run tests to verify they fail**

  Expected: the updated empty-defaults test fails (returns `''` today).

- [ ] **Step 3: Implement Part A (empty-string defaults).**

  Update the two relevant return values in `loadSystemPromptContext`.

- [ ] **Step 4: Implement Part B (extract constant).**

  Create / append `src/lib/limits.ts`. Import in `agent-run.ts`. Replace local literal.

- [ ] **Step 5: Implement Part C (drop casts).**

  Walk every `as Array<{...}>` in `system-prompt-context.ts`. Delete the cast suffix; let inferred types stand. If a real type mismatch surfaces, fix the underlying query (don't just re-cast).

- [ ] **Step 6: Run tests to verify they pass**

  Run: `pnpm vitest run src/lib/team/__tests__/system-prompt-context.test.ts src/workers/processors/__tests__/agent-run.test.ts`
  Expected: all green.

- [ ] **Step 7: Type-check**

  Run: `pnpm tsc --noEmit --pretty false`
  Expected: exit 0.

- [ ] **Step 8: Commit**

  ```bash
  git add src/lib/limits.ts \
          src/lib/team/system-prompt-context.ts \
          src/lib/team/__tests__/system-prompt-context.test.ts \
          src/workers/processors/agent-run.ts
  git commit -m "$(cat <<'EOF'
  polish(team-lead): empty-string defaults, named truncation limit, drop unsafe casts

  Three small wins:
  - statusBreakdown / teamRoster default to '(none)' / '(none yet ...)'
    when empty so the lead's prompt doesn't render bare 'B:' / 'T:' rows.
  - Extract the 4000-char tool-result truncation limit to lib/limits.ts
    as TOOL_RESULT_TRUNCATION_LIMIT so the activity-log renderer can
    reference the same constant.
  - Drop `as Array<{...}>` casts in system-prompt-context.ts — let
    Drizzle infer return types so a column rename surfaces at compile
    time instead of silently drifting.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Self-review checklist (controller runs after writing the plan)

- [x] **Spec coverage** — every flagged finding from the prior code-review and gap-audit cycle has a dedicated step.
- [x] **Placeholder scan** — no "TBD", no "implement appropriate". Every step has executable code or explicit cited references.
- [x] **Out-of-scope deferrals documented** — `createTeamPlatformDeps` memoization (needs invalidation design) and test-args[7] sturdiness (LOW, test-only) explicitly listed in the "What's OUT of scope" section.
- [x] **Type consistency** — `loadSystemPromptContext` return type changes once and is consumed identically.
- [x] **Build gate** — every implementing task ends with `pnpm tsc --noEmit --pretty false`.
- [x] **CLAUDE.md compliance** — no platform sniffing, no direct `XClient.fromChannel`, callerRole wiring is via the SSOT `assembleToolPool` family (no role-based gating outside that pipeline).
