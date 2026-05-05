# Agent Teams — Phase E: Team-Lead Unification (X Driver) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `team-run.ts` legacy driver with the unified `agent-run` lifecycle. The team-lead becomes a regular `agent_runs` row with `role='lead'`. Founder UI input enters via `team_messages` (with `to_agent_id=lead.agentId`), wakes the lead through the same path as any other message. After Phase E, `agent-run` is the SOLE driver for both lead and teammate; `team-run.ts` is deleted; Phase B/C/D kludges (parentAgentId=null, wake-by-memberId, custom drain hook) are replaced with proper agent_runs routing.

**Architecture:** Add a per-team `lead` agent_runs row created at team creation (`status='sleeping'`). API endpoint POST /api/team/run no longer enqueues team-run jobs — it inserts a `team_messages` row addressed to the lead's agentId and calls `wake(leadAgentId)`. The agent-run processor extends to recognize `role='lead'` agents and apply lead-specific behaviors (load conversation history via existing `loadConversationHistory(teamId, conversationId)`, wire SSE pub/sub for live UI updates). Task tool's async branch sets `parentAgentId` to the caller's agent_runs.id (no longer null). SendMessage's wake routing uses `agent_runs.id` (replaces Phase C's wake-by-memberId kludge). team-run.ts's drain hook (Phase B Task 12) is removed — lead drains via standard agent-run mailbox-drain. team-run.ts file is deleted in the final task. **This is the highest-risk phase**: the cutover touches the founder UI flow. Product is not yet launched, so risk is code-correctness, not user-facing.

**Tech Stack:** TypeScript 5, Vitest, Drizzle, BullMQ, Postgres.

**Spec reference:** `docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md` § Phase E.

**Phase E non-goals**:
- Three-mode team-lead AGENT.md prompt — Phase F
- Final flag drop / cleanup — Phase G
- Any new founder-facing features

---

## File structure

**New files (3):**

| Path | Responsibility |
|---|---|
| `src/lib/team/spawn-lead.ts` | `ensureLeadAgentRun(teamId, db): Promise<{agentId: string}>` — finds-or-creates the lead agent_runs row for a team. Idempotent. Used by API route + team creation flow |
| `src/lib/team/__tests__/spawn-lead.test.ts` | Unit tests (creates row when absent; returns existing when present; sets correct shape) |
| `src/lib/team/find-lead-agent.ts` | `findLeadAgentId(teamId, db): Promise<string | null>` — read-only lookup; replaces all the `getLeadAgentId` placeholder helpers in Phase C with one canonical impl |

**Modified files (8):**

| Path | What changes |
|---|---|
| `src/app/api/team/run/route.ts` | Replace `enqueueTeamRun` call with: ① `ensureLeadAgentRun(teamId)` → leadAgentId; ② insert `team_messages` row (toAgentId=leadAgentId, type='user_prompt', content=run.goal, messageType='message'); ③ `wake(leadAgentId)`. Returns the inserted message id and leadAgentId. Old fields (`runId`, `traceId`, `alreadyRunning`) preserved for response shape compat — generate them from the new flow |
| `src/workers/processors/agent-run.ts` | Extend lead path: when row.role='lead', load conversation history via existing `loadConversationHistory` (pre-Phase-E mechanism, still works); register cancellation listener (mailbox shutdown_request to lead → graceful exit); wire SSE pub/sub events as the lead emits messages |
| `src/tools/AgentTool/AgentTool.ts` | Task tool's async branch: replace `parentAgentId: null` with `parentAgentId: callerAgentId` (read from ctx — agent-run injects). Add `callerAgentId` injection in agent-run's tool ctx |
| `src/tools/SendMessageTool/SendMessageTool.ts` | Replace `wake(toMemberId)` in dispatchShutdownRequest + dispatchPlanApprovalResponse with proper agent_runs routing: lookup `agent_runs WHERE memberId=toMemberId AND status IN ('running', 'sleeping')`, wake by `agent_runs.id`. Replace inline `getLeadAgentId` helper that returns null with `findLeadAgentId` import |
| `src/workers/processors/agent-run.ts` (synth notification path) | Phase B kludge `if (!parentAgentId) return;` short-circuit can stay (defensive), but parentAgentId is now ALWAYS set for teammate spawns — verify and document |
| `src/workers/processors/team-run.ts` | **DELETED** in Task 11 (the final task) |
| `src/workers/index.ts` | Remove team-run Worker registration (Task 11) |
| `src/lib/queue/team-run.ts` | Keep for now (other code may import the queue name); revisit in Phase G |

**Total:** 3 new + 6 modifications + 2 deletions across 11 tasks.

---

## Sequence + dependencies

```
Task 1 (spawn-lead factory)   ──┐
Task 2 (find-lead-agent)      ──┴─▶ Task 3 (API route refactor)
                                                │
Task 4 (agent-run lead init) ◄──────────────────┤
                              │                 │
Task 5 (agent-run lead       ─┤
        cancellation)         │
                              │
Task 6 (agent-run lead SSE)  ─┴────────────────▶ Task 7 (Task tool parentAgentId)
                                                                    │
Task 8 (SendMessage wake     ◄──────────────────────────────────────┤
        routing — kludge fix)                                       │
                                                                    ▼
                                                     Task 9 (migration backfill script)
                                                                    │
                                                                    ▼
                                                     Task 10 (e2e founder UI roundtrip)
                                                                    │
                                                                    ▼
                                                     Task 11 (DELETE team-run.ts + verification gate)
```

---

## Task 1: spawn-lead factory

**Files:**
- Create: `src/lib/team/spawn-lead.ts`
- Test: `src/lib/team/__tests__/spawn-lead.test.ts`

`ensureLeadAgentRun(teamId, db)` — idempotently finds-or-creates the lead's `agent_runs` row for a given team. Called at team creation AND at first founder UI message (so existing teams pre-Phase-E get a lead row on first interaction).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { ensureLeadAgentRun } from '@/lib/team/spawn-lead';

function makeDb(opts: { existing?: { id: string } | null; insertSpy?: ReturnType<typeof vi.fn> } = {}) {
  const insertSpy = opts.insertSpy ?? vi.fn();
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => opts.existing ? [opts.existing] : []),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (vals: unknown) => {
        insertSpy(vals);
        return [{ id: (vals as { id: string }).id }];
      }),
    })),
  };
}

describe('ensureLeadAgentRun', () => {
  it('returns existing leadAgentId when present', async () => {
    const db = makeDb({ existing: { id: 'existing-lead-1' } });
    const result = await ensureLeadAgentRun('team-1', db as never);
    expect(result.agentId).toBe('existing-lead-1');
  });

  it('creates new lead row when absent', async () => {
    const insertSpy = vi.fn();
    const db = makeDb({ existing: null, insertSpy });
    const result = await ensureLeadAgentRun('team-1', db as never);
    expect(result.agentId).toBeTruthy();
    expect(insertSpy).toHaveBeenCalledOnce();
    const inserted = insertSpy.mock.calls[0][0];
    expect(inserted.teamId).toBe('team-1');
    expect(inserted.status).toBe('sleeping');
    expect(inserted.parentAgentId).toBeNull();
  });

  it('idempotent — concurrent calls return same agentId', async () => {
    let cached: { id: string } | null = null;
    const insertSpy = vi.fn();
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => cached ? [cached] : []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (vals: unknown) => {
          const v = vals as { id: string };
          cached = { id: v.id };
          insertSpy(vals);
          return [cached];
        }),
      })),
    };
    const r1 = await ensureLeadAgentRun('team-1', db as never);
    const r2 = await ensureLeadAgentRun('team-1', db as never);
    expect(r1.agentId).toBe(r2.agentId);
    expect(insertSpy).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/lib/team/__tests__/spawn-lead.test.ts
```

- [ ] **Step 3: Implement spawn-lead.ts**

```ts
// Phase E: ensure each team has exactly one lead agent_runs row.
//
// Before Phase E, the lead was driven implicitly by team-run.ts and never
// had its own agent_runs row. Phase E unifies: lead is just an agent_runs
// row with role='lead' (logically — but agent_runs has no role column;
// we look up the team's "lead" agentDefName via team_members instead).
//
// `ensureLeadAgentRun` is idempotent: returns the existing lead's agentId,
// or creates a new sleeping row if absent. Called from the founder UI
// API route + (future) at team creation time.

import { and, eq } from 'drizzle-orm';
import { agentRuns, teamMembers } from '@/lib/db/schema';
import type { Database } from '@/lib/db';

const LEAD_AGENT_DEF_NAME = 'coordinator'; // Phase F may rename to 'team-lead'

export interface EnsureLeadResult {
  agentId: string;
}

export async function ensureLeadAgentRun(
  teamId: string,
  db: Database,
): Promise<EnsureLeadResult> {
  // Look for existing lead row
  const existing = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.teamId, teamId),
        eq(agentRuns.agentDefName, LEAD_AGENT_DEF_NAME),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return { agentId: existing[0].id };
  }

  // Find lead's team_members row (lead is identified by matching agentType)
  const leadMember = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.agentType, LEAD_AGENT_DEF_NAME),
      ),
    )
    .limit(1);
  if (leadMember.length === 0) {
    throw new Error(`Cannot ensure lead agent_run: team ${teamId} has no member with agentType=${LEAD_AGENT_DEF_NAME}`);
  }

  // Create new sleeping row
  const newId = crypto.randomUUID();
  await db.insert(agentRuns).values({
    id: newId,
    teamId,
    memberId: leadMember[0].id,
    agentDefName: LEAD_AGENT_DEF_NAME,
    parentAgentId: null,
    status: 'sleeping',
  });

  return { agentId: newId };
}
```

- [ ] **Step 4: Run — verify pass**

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/lib/team/
git commit -m "feat(team): ensureLeadAgentRun factory — idempotent lead row creation (Phase E)"
```

---

## Task 2: find-lead-agent helper

**Files:**
- Create: `src/lib/team/find-lead-agent.ts`
- Test: `src/lib/team/__tests__/find-lead-agent.test.ts`

`findLeadAgentId(teamId, db): Promise<string | null>` — read-only lookup. Used by SendMessage to resolve "the lead" for peer-DM-shadow + wake routing. Replaces the placeholder `getLeadAgentId` helpers from Phase C that returned null.

- [ ] **Step 1: Test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { findLeadAgentId } from '@/lib/team/find-lead-agent';

describe('findLeadAgentId', () => {
  it('returns lead agentId when present', async () => {
    const db = { select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ id: 'lead-1' }]),
        })),
      })),
    })) };
    const result = await findLeadAgentId('team-1', db as never);
    expect(result).toBe('lead-1');
  });

  it('returns null when no lead row exists yet', async () => {
    const db = { select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
        })),
      })),
    })) };
    const result = await findLeadAgentId('team-1', db as never);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Implement**

```ts
import { and, eq } from 'drizzle-orm';
import { agentRuns } from '@/lib/db/schema';
import type { Database } from '@/lib/db';

const LEAD_AGENT_DEF_NAME = 'coordinator';

export async function findLeadAgentId(
  teamId: string,
  db: Database,
): Promise<string | null> {
  const rows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.teamId, teamId),
        eq(agentRuns.agentDefName, LEAD_AGENT_DEF_NAME),
      ),
    )
    .limit(1);
  return rows.length > 0 ? rows[0].id : null;
}
```

- [ ] **Step 3: Verify pass + typecheck + commit**

```bash
pnpm vitest run src/lib/team/__tests__/find-lead-agent.test.ts
pnpm tsc --noEmit --pretty false
git add src/lib/team/find-lead-agent.ts src/lib/team/__tests__/find-lead-agent.test.ts
git commit -m "feat(team): findLeadAgentId helper (Phase E)"
```

---

## Task 3: API route — replace enqueueTeamRun with insert+wake

**Files:**
- Modify: `src/app/api/team/run/route.ts`

The current route enqueues a BullMQ team-run job. Phase E flow:
1. Validate request (existing logic preserved)
2. `ensureLeadAgentRun(teamId)` → leadAgentId
3. Insert `team_messages` row: type='user_prompt', toAgentId=leadAgentId, content=run.goal, messageType='message'
4. `wake(leadAgentId)`
5. Return response with the same shape (runId/traceId can be derived from the message id)

**Critical**: this preserves the API contract (response shape, status codes) so downstream UI doesn't break.

- [ ] **Step 1: Read current route to know its full shape**

```bash
sed -n '180,260p' src/app/api/team/run/route.ts
```

- [ ] **Step 2: Replace the enqueueTeamRun call**

In `src/app/api/team/run/route.ts`, replace the `enqueueTeamRun({...})` call (line ~228 per earlier grep) with:

```ts
import { ensureLeadAgentRun } from '@/lib/team/spawn-lead';
import { wake } from '@/workers/processors/lib/wake';
import { teamMessages } from '@/lib/db/schema';

// In the route handler, after validation:

const { agentId: leadAgentId } = await ensureLeadAgentRun(team.id, db);

const messageId = crypto.randomUUID();
await db.insert(teamMessages).values({
  id: messageId,
  teamId: team.id,
  type: 'user_prompt',
  messageType: 'message',
  fromMemberId: null, // user-originated
  toAgentId: leadAgentId,
  content: run.goal,
  summary: run.goal.slice(0, 80),
});

await wake(leadAgentId);

// Return response — use messageId as the new runId surrogate to preserve
// API shape. Generate a traceId from the leadAgentId for log correlation.
return NextResponse.json({
  runId: messageId,
  traceId: leadAgentId,
  alreadyRunning: false, // wake() is idempotent so this is always false now
}, { status: 200 });
```

- [ ] **Step 3: Update tests for the route**

```bash
ls src/app/api/team/run/__tests__/ 2>/dev/null
```

If route tests exist, update assertions for new response shape (runId derived from messageId; traceId derived from leadAgentId).

- [ ] **Step 4: Verify route works end-to-end (manually or via integration test if available)**

If no integration test exists, that's deferred to Task 10.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/app/api/team/run/route.ts
git commit -m "feat(api/team/run): replace enqueueTeamRun with insert+wake (Phase E)"
```

---

## Task 4: agent-run lead init — load conversation history for lead

**Files:**
- Modify: `src/workers/processors/agent-run.ts`

When `processAgentRun` loads an `agent_runs` row, check if it's the lead (`agentDefName === 'coordinator'`). If lead:
1. Resolve the team's active conversationId (look up `team_conversations` for the team's primary conversation)
2. Load priorMessages via existing `loadConversationHistory(teamId, {conversationId, db})` — same path team-run.ts used (lines 789-801 of team-run.ts)
3. Pass priorMessages to runAgent

Lead's conversation history is the founder/lead chat, persisted across runs. Each agent_runs row for the lead reuses the team's persistent conversation.

- [ ] **Step 1: Read team-run.ts's loadConversationHistory usage**

```bash
sed -n '785,810p' src/workers/processors/team-run.ts
```

- [ ] **Step 2: Add the lead-init test in agent-run.test.ts**

```ts
it('lead agent loads conversation history via loadConversationHistory', async () => {
  vi.mock('@/lib/team-conversation', () => ({
    loadConversationHistory: vi.fn(async () => [
      { role: 'user', content: 'previous chat msg 1' },
      { role: 'assistant', content: 'previous reply' },
    ]),
  }));
  // mock agent_runs row with agentDefName='coordinator' (lead)
  // ...
  await processAgentRun(makeJob('lead-1'));
  // assert: runAgent called with priorMessages = the loaded history
  const runAgentCall = vi.mocked(runAgent).mock.calls[0];
  expect(runAgentCall[10]).toEqual([
    { role: 'user', content: 'previous chat msg 1' },
    { role: 'assistant', content: 'previous reply' },
  ]);
});

it('non-lead agent uses loadAgentRunHistory (Phase D path)', async () => {
  // existing Phase D resume test should still pass — lead init is conditional
});
```

- [ ] **Step 3: Modify processAgentRun in agent-run.ts**

```ts
import { loadConversationHistory } from '@/lib/team-conversation';

// in processAgentRun, in the priorMessages resolution block:

const isLead = def.role === 'lead';
let priorMessages: Anthropic.Messages.MessageParam[] = [];

if (isLead) {
  // Lead: load the team's persistent conversation (founder chat history).
  // Each lead agent-run shares the team's primary conversation.
  const conversationId = await resolvePrimaryConversation(row.teamId, db);
  if (conversationId) {
    priorMessages = await loadConversationHistory(row.teamId, { conversationId, db });
  }
} else if (row.status === 'sleeping') {
  // Teammate resume from Phase D
  priorMessages = await loadAgentRunHistory(agentId, db);
}
```

`resolvePrimaryConversation(teamId, db)`: looks up `team_conversations.id` for the team's primary conversation (the most recent one, or the one explicitly marked primary). For Phase E MVP: just `SELECT id FROM team_conversations WHERE teamId=? ORDER BY createdAt DESC LIMIT 1` — the founder usually has one ongoing conversation per team.

- [ ] **Step 4: Verify tests pass + typecheck + commit**

```bash
pnpm vitest run src/workers/processors/__tests__/agent-run.test.ts
pnpm tsc --noEmit --pretty false
git add src/workers/processors/agent-run.ts \
        src/workers/processors/__tests__/agent-run.test.ts
git commit -m "feat(agent-run): lead loads conversation history via loadConversationHistory (Phase E)"
```

---

## Task 5: agent-run lead cancellation listener

**Files:**
- Modify: `src/workers/processors/agent-run.ts`

team-run.ts subscribes to a Redis cancellation channel (line 588 area) so the founder can cancel a running team-run. Phase E moves this into agent-run for the lead path.

For the unified model: cancellation = SendMessage with type='shutdown_request'. Phase C already handles shutdown_request → graceful exit. So this task is mostly about ensuring the legacy `/api/team/run/[runId]/cancel` endpoint inserts a shutdown_request mailbox row instead of publishing to Redis.

- [ ] **Step 1: Find the cancel endpoint**

```bash
find src/app/api -name "cancel*" -o -name "*cancel*"
```

Likely: `src/app/api/team/run/[runId]/cancel/route.ts` or similar.

- [ ] **Step 2: Refactor cancel endpoint**

Replace the Redis publish with:

```ts
// Insert a shutdown_request to the lead's mailbox.
await db.insert(teamMessages).values({
  teamId,
  type: 'user_prompt',
  messageType: 'shutdown_request',
  fromMemberId: null,
  toAgentId: leadAgentId,
  content: 'Cancelled by founder',
  summary: 'cancel',
});
await wake(leadAgentId);
```

The lead's agent-run loop, on next idle drain, sees the shutdown_request → exits gracefully (Phase C Task 7 logic already handles this).

- [ ] **Step 3: Update cancel endpoint test if exists**

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/app/api/team/run
git commit -m "feat(api): cancel via shutdown_request mailbox row (Phase E)"
```

---

## Task 6: agent-run lead SSE — wire team_messages SSE channel

**Files:**
- Modify: `src/workers/processors/agent-run.ts`

team-run.ts publishes assistant messages + tool events to a Redis SSE channel (`team:${teamId}:messages`) for live UI updates. Phase E moves this into agent-run for the lead.

For the unified model: when lead's agent-run persists an assistant turn (Phase D Task 5 added `assistant_text_stop` → team_messages insert), additionally publish to the SSE channel.

The cleanest implementation: add an `onEvent` hook that, when row.role === 'lead', publishes the event to Redis SSE in addition to persisting.

- [ ] **Step 1: Add SSE publish in agent-run for lead**

Look at how team-run.ts publishes (search for `pub.publish` or `getPubSubPublisher`):

```bash
grep -n "publish\|getPubSubPublisher\|teamMessagesChannel" /Users/yifeng/Documents/Code/shipflare/src/workers/processors/team-run.ts | head -10
```

Mirror the pattern in agent-run.ts's onEvent for lead role.

- [ ] **Step 2: Test that lead's assistant turns are SSE-published**

Add a test asserting `pub.publish` is called when isLead=true.

- [ ] **Step 3: Typecheck + commit**

```bash
git add src/workers/processors/agent-run.ts \
        src/workers/processors/__tests__/agent-run.test.ts
git commit -m "feat(agent-run): publish lead assistant turns to SSE channel (Phase E)"
```

---

## Task 7: Task tool — proper parentAgentId routing

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.ts`
- Test: `src/tools/AgentTool/__tests__/Task.test.ts`

Phase B Task 11 set `parentAgentId: null` as a kludge. Phase E lifts this: read the caller's agentId from ToolContext (`callerAgentId` key, which agent-run already injects per Phase D Task 4) and use it as the parent.

- [ ] **Step 1: Update launchAsyncTeammate**

In `src/tools/AgentTool/AgentTool.ts`'s `launchAsyncTeammate` helper:

```ts
function getCallerAgentId(ctx: ToolContext): string | null {
  try {
    return ctx.get<string>('callerAgentId');
  } catch {
    return null;
  }
}

// in launchAsyncTeammate:
const parentAgentId = getCallerAgentId(ctx); // null if called outside agent-run

await deps.db.insert(agentRuns).values({
  id: agentId,
  teamId: deps.teamId,
  memberId: deps.currentMemberId,
  agentDefName: input.subagent_type,
  parentAgentId, // Phase E: properly set; Phase B kludge removed
  status: 'queued',
});
```

- [ ] **Step 2: Add test asserting parentAgentId is set when callerAgentId is present**

- [ ] **Step 3: Verify pass + typecheck + commit**

```bash
git add src/tools/AgentTool/AgentTool.ts \
        src/tools/AgentTool/__tests__/Task.test.ts
git commit -m "feat(Task): set parentAgentId from callerAgentId — Phase B kludge removed (Phase E)"
```

---

## Task 8: SendMessage wake routing — use agent_runs.id

**Files:**
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts`

Phase C Task 2 dispatched shutdown_request and plan_approval_response with `wake(toMemberId)` — calling wake with a team_members.id instead of an agent_runs.id. Phase E fixes: lookup agent_runs WHERE memberId=toMemberId AND status IN ('running', 'sleeping') → use that agent_runs.id for the wake call AND for the toAgentId field on the inserted message.

- [ ] **Step 1: Update dispatchShutdownRequest, dispatchPlanApprovalResponse**

```ts
// Replace:
//   toAgentId: toMemberId  // OLD kludge
// With:
async function resolveTargetAgentRun(toMemberId: string, db: Database): Promise<string | null> {
  const rows = await db.select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(
      eq(agentRuns.memberId, toMemberId),
      inArray(agentRuns.status, ['running', 'sleeping']),
    ))
    .orderBy(desc(agentRuns.lastActiveAt))
    .limit(1);
  return rows.length > 0 ? rows[0].id : null;
}

// In dispatchShutdownRequest:
const targetAgentId = await resolveTargetAgentRun(toMemberId, db);
if (!targetAgentId) {
  throw new Error(`shutdown_request: no active agent_run for member ${toMemberId}`);
}
await db.insert(teamMessages).values({
  // ...
  toAgentId: targetAgentId,
  toMemberId, // keep for backward-compat / debugging
  // ...
});
await wake(targetAgentId);
```

Same pattern for `dispatchPlanApprovalResponse`.

- [ ] **Step 2: Update tests**

Mocks need to return an agent_runs row when the lookup runs. Adjust the existing fakeDb to handle the new query.

- [ ] **Step 3: Verify pass + typecheck + commit**

```bash
git add src/tools/SendMessageTool/SendMessageTool.ts \
        src/tools/SendMessageTool/__tests__/SendMessageTool.test.ts
git commit -m "feat(SendMessage): wake by agent_runs.id, not memberId — Phase C kludge removed (Phase E)"
```

---

## Task 9: Migration — backfill agent_runs row for existing teams

**Files:**
- Create: `scripts/backfill-lead-agent-runs.ts`

Existing teams (created pre-Phase E) have no lead `agent_runs` row. This script iterates teams, calls `ensureLeadAgentRun` for each.

- [ ] **Step 1: Write script**

```ts
// scripts/backfill-lead-agent-runs.ts — one-shot migration.
import { db } from '@/lib/db';
import { teams } from '@/lib/db/schema';
import { ensureLeadAgentRun } from '@/lib/team/spawn-lead';

async function main() {
  const allTeams = await db.select({ id: teams.id }).from(teams);
  console.log(`Backfilling lead agent_runs for ${allTeams.length} teams`);
  for (const team of allTeams) {
    try {
      const { agentId } = await ensureLeadAgentRun(team.id, db);
      console.log(`  team ${team.id} → lead ${agentId}`);
    } catch (err) {
      console.error(`  team ${team.id} FAILED:`, err);
    }
  }
  console.log('Done');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run on local DB**

```bash
pnpm tsx scripts/backfill-lead-agent-runs.ts
```

- [ ] **Step 3: Verify via psql**

```bash
psql $POSTGRES_URL -c "SELECT count(*), agent_def_name FROM agent_runs WHERE agent_def_name = 'coordinator' GROUP BY agent_def_name"
```

Should report a row count = number of teams.

- [ ] **Step 4: Commit script (don't include the run output)**

```bash
git add scripts/backfill-lead-agent-runs.ts
git commit -m "chore(scripts): backfill-lead-agent-runs migration script (Phase E)"
```

---

## Task 10: End-to-end founder UI roundtrip test

**Files:**
- Create: `src/app/api/team/run/__tests__/route.integration.test.ts` (or extend existing if present)

Integration test simulating the full Phase E flow:
1. POST /api/team/run with a goal
2. Verify team_messages row inserted with toAgentId=lead, content=goal
3. Verify agent_runs row for lead exists (created or found)
4. Verify wake was called for lead
5. (Optional, if BullMQ is available locally): wait for agent-run to pick up the lead, run, exit

- [ ] **Step 1: Write the integration test**

(Adapt to whatever integration-test framework shipflare uses — likely vitest with a test DB)

- [ ] **Step 2: Verify pass**

- [ ] **Step 3: Commit**

```bash
git add src/app/api/team/run/__tests__/
git commit -m "test(api/team/run): e2e founder UI roundtrip via agent-run lead path (Phase E)"
```

---

## Task 11: DELETE team-run.ts + verification gate

**Files:**
- Delete: `src/workers/processors/team-run.ts`
- Delete: `src/workers/processors/__tests__/team-run.integration.test.ts` (if exists)
- Modify: `src/workers/index.ts` (remove team-run Worker registration)
- Modify: `src/lib/queue/index.ts` (optional: remove team-run re-export if no longer imported)

The cutover: with all the Phase E changes in place, team-run.ts is now dead code. Delete it.

- [ ] **Step 1: Find all imports of team-run.ts**

```bash
grep -rn "from '@/workers/processors/team-run'" src/ --include="*.ts" 2>&1 | head -10
grep -rn "processTeamRun\|TEAM_RUN_QUEUE_NAME\|enqueueTeamRun" src/ --include="*.ts" 2>&1 | head -20
```

Update or remove each importer:
- `src/workers/index.ts` — remove the `processTeamRun` import + Worker registration
- Any other importer — likely needs to migrate to the new agent-run path or be deleted

- [ ] **Step 2: Delete team-run.ts**

```bash
git rm src/workers/processors/team-run.ts
```

- [ ] **Step 3: Delete team-run integration test (if it exists)**

```bash
git rm src/workers/processors/__tests__/team-run.integration.test.ts 2>/dev/null || true
```

- [ ] **Step 4: Update workers/index.ts**

Remove the `import { processTeamRun }` and the `teamRunWorker = new Worker(TEAM_RUN_QUEUE_NAME, ...)` block.

- [ ] **Step 5: Run the full test sweep**

```bash
pnpm tsc --noEmit --pretty false
pnpm test 2>&1 | tail -40
```

Expected: no new red beyond what was already broken. Tests that depended on team-run.ts should be updated or removed.

- [ ] **Step 6: Tag the milestone**

```bash
git add -A
git commit -m "chore(workers): delete team-run.ts — agent-run is sole driver (Phase E)"
git tag -a phase-e-unify-team-lead -m "Agent Teams Phase E — Team-lead unification complete"
```

- [ ] **Step 7: Update spec doc**

Append to `## Implementation status`:

```markdown
- **Phase E — Team-lead unification (X driver):** landed `2026-05-02` on `dev`.
  team-run.ts DELETED. agent-run is the sole driver for both lead and teammate.
  Lead is an agent_runs row with agentDefName='coordinator'; founder UI input
  enters via team_messages (toAgentId=lead.agentId) + wake(); cancellation also
  via shutdown_request mailbox row. Phase B/C kludges replaced: parentAgentId
  properly set from callerAgentId (Task 7); SendMessage wake routing uses
  agent_runs.id (Task 8); lead drains via standard mailbox-drain (custom drain
  hook removed). Migration script backfills lead agent_runs for existing teams.
  - Task 1 — spawn-lead factory: <SHA>
  - Task 2 — find-lead-agent helper: <SHA>
  - Task 3 — API route refactor: <SHA>
  - Task 4 — agent-run lead init: <SHA>
  - Task 5 — agent-run lead cancellation: <SHA>
  - Task 6 — agent-run lead SSE wiring: <SHA>
  - Task 7 — Task tool parentAgentId proper: <SHA>
  - Task 8 — SendMessage wake routing fix: <SHA>
  - Task 9 — backfill migration script: <SHA>
  - Task 10 — e2e founder UI test: <SHA>
  - Task 11 — DELETE team-run.ts: <SHA>
```

- [ ] **Step 8: Commit doc update**

```bash
git add docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md
git commit -m "docs(spec): mark Agent Teams Phase E landed"
```

---

## Acceptance criteria

- [ ] `ensureLeadAgentRun` factory exists and is idempotent
- [ ] `findLeadAgentId` helper exists
- [ ] API route /api/team/run inserts message + calls wake (no enqueueTeamRun)
- [ ] Cancel endpoint inserts shutdown_request mailbox row
- [ ] agent-run loads conversation history for lead via loadConversationHistory
- [ ] agent-run wires SSE pub/sub for lead's assistant turns
- [ ] Task tool's async branch sets parentAgentId from callerAgentId (no longer null)
- [ ] SendMessage's wake calls use agent_runs.id (no longer toMemberId)
- [ ] Migration script backfills existing teams
- [ ] team-run.ts is DELETED
- [ ] team-run worker registration removed from workers/index.ts
- [ ] All Phase A/B/C/D tests still green
- [ ] tsc clean
- [ ] Local tag `phase-e-unify-team-lead`
- [ ] Spec doc has Phase E landed timestamp + 11 commit SHAs

---

## Self-review notes

1. **High-risk task is Task 11 (the actual delete).** All prior tasks build the new path; Task 11 retires the old one. If anything was missed in Tasks 1-10, the test suite will fail at Task 11.
2. **team-run.ts has 1349 lines** — significant feature surface (transcript persistence, cancellation, SSE, user-message injection, conversation tracking). Phase E moves the architectural shape; some peripheral features may need follow-up tasks if they don't transfer cleanly.
3. **Phase E does NOT rename coordinator → team-lead** in AGENT.md (that's Phase F). LEAD_AGENT_DEF_NAME is hardcoded to 'coordinator' for now.
4. **Migration script in Task 9 is one-shot** — needs to be run manually on each environment. Document this in deployment runbook.
5. **Cancellation listener in Task 5** changes the cancel API contract: previously was a Redis publish (synchronous-looking from the API perspective); now it's an INSERT + wake (eventually consistent). The API may need to communicate "cancel scheduled, may take seconds to take effect" to the UI.
