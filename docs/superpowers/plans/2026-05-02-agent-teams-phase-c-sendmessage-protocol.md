# Agent Teams — Phase C: SendMessage Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full Agent Teams P2P communication: SendMessage discriminated union with 5 variants (message / broadcast / shutdown_request / shutdown_response / plan_approval_response), TaskStop tool with graceful shutdown, peer-DM-shadow visibility for the lead, and agent-run mailbox-drain hook at idle turns. Under flag-on, lead can `Task.spawn` two teammates A and B; A can SendMessage to B; lead sees a peer-DM shadow with summary; lead can TaskStop A → A receives shutdown_request → A graceful exits → lead receives `<task-notification status="killed">`.

**Architecture:** Extend `SendMessageTool` (currently a flat `{to, message}` schema) into a discriminated union that supports the engine PDF §4.1 5-variant protocol. The legacy single-recipient form maps to `type: 'message'` (default if discriminator absent — preserves backward-compat for existing callers). Address resolution still supports both teammate name (display_name) and agent_runs.id; Phase C adds dispatch logic per type. Add `TaskStop` tool that writes a `shutdown_request` mailbox row + cancels the BullMQ job; teammate's agent-run loop drains the mailbox at each idle turn and exits gracefully when it sees a shutdown_request. Peer-DM messages additionally insert a summary-only "shadow" row to the lead's mailbox WITHOUT waking the lead (low-cost transparency, engine PDF §3.6.1 channel ③).

**Tech Stack:** TypeScript 5, Vitest, Zod (`discriminatedUnion`), Drizzle, BullMQ.

**Spec reference:** `docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md` § Phase C + §4.

**Phase C non-goals** (per spec; deferred):
- `Sleep` tool — Phase D
- team-run unification (X driver) — Phase E
- KAIROS / autoDream / ULTRAPLAN — out of scope
- Full team-lead three-mode dispatch prompt — Phase F

---

## File structure

**New files (5):**

| Path | Responsibility |
|---|---|
| `src/tools/TaskStopTool/TaskStopTool.ts` | New `TaskStop` tool. Input: `{task_id}` (= agent_runs.id). Cancels BullMQ job + writes `shutdown_request` row to teammate's mailbox + marks `agent_runs.status='killed'` |
| `src/tools/TaskStopTool/__tests__/TaskStopTool.test.ts` | Validates: writes shutdown_request row; calls wake; rejects when caller isn't lead (or when target's status is already terminal) |
| `src/workers/processors/lib/peer-dm-shadow.ts` | `insertPeerDmShadow({fromAgentId, toAgentId, summary, teamId, db})` — when teammate→teammate `message` is sent, ALSO insert a summary-only shadow row addressed to the lead. **Critical invariant**: this function does NOT call `wake()` — the shadow is a passive transparency record, not a wake event |
| `src/workers/processors/lib/__tests__/peer-dm-shadow.test.ts` | Verifies shadow insertion + critical no-wake invariant |
| `src/tools/SendMessageTool/__tests__/discriminated-union.test.ts` | Per-variant validation tests (5 variants × valid/invalid input shapes) |

**Modified files (5):**

| Path | What changes |
|---|---|
| `src/tools/SendMessageTool/SendMessageTool.ts` | Schema becomes `discriminatedUnion('type', [...])` with 5 variants. `type: 'message'` default for backward-compat (preprocessor injects when absent). Execute() dispatches by variant. Runtime validation: `plan_approval_response` is lead-only; `broadcast` 1-per-turn rate limit (best-effort via DB query) |
| `src/tools/SendMessageTool/__tests__/SendMessageTool.test.ts` | Existing tests updated for discriminated-union compatibility (legacy callers still work via type='message' default); new variant-specific tests appended |
| `src/workers/processors/agent-run.ts` | Extend the inner runAgent loop with mailbox drain at idle turns. On shutdown_request received: graceful exit (mark status='killed', synthesize notification with status='killed') |
| `src/workers/processors/__tests__/agent-run.test.ts` | Add cases: drain hook fires at idle turn; shutdown_request triggers graceful exit |
| `src/tools/AgentTool/blacklists.ts` | Add `TASK_STOP_TOOL_NAME` to `INTERNAL_TEAMMATE_TOOLS` |
| `src/tools/registry.ts` (or registry-team.ts if appropriate) | Register the new `taskStopTool` |

**Total:** 5 new + 6 modifications = 11 file touches across 7 tasks.

---

## Sequence + dependencies

```
Task 1 (SendMessage discriminated union schema)  ─┐
Task 2 (SendMessage execute() dispatch)          ─┤
Task 3 (SendMessage runtime validation)          ─┴─▶ Task 5 (peer-DM shadow wired)

Task 4 (peer-DM-shadow helper)  ──────────────────────▶ Task 5

Task 6 (TaskStop tool + register + blacklist)    ─┐
Task 7 (agent-run drain + shutdown handler)      ─┴─▶ Task 8 (verification gate)
```

---

## Task 1: SendMessage — discriminated union schema

**Files:**
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts` (schema only — execute body changes in Task 2)
- Test: `src/tools/SendMessageTool/__tests__/discriminated-union.test.ts` (NEW)

The schema changes from a flat `{to, message}` to a 5-variant discriminated union. Backward compat: a Zod preprocessor injects `type: 'message'` when callers omit the discriminator (preserves the legacy `{to, message}` shape for existing call sites in team-run.ts).

- [ ] **Step 1: Write the failing test**

Create `src/tools/SendMessageTool/__tests__/discriminated-union.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SendMessageInputSchema } from '@/tools/SendMessageTool/SendMessageTool';

describe('SendMessage discriminated union — Phase C', () => {
  describe('type: message (default)', () => {
    it('accepts {to, message} legacy shape (preprocessor defaults type)', () => {
      const parsed = SendMessageInputSchema.parse({
        to: 'researcher',
        message: 'Hello',
      });
      expect(parsed.type).toBe('message');
      expect(parsed.to).toBe('researcher');
      expect(parsed.content).toBe('Hello');
    });
    it('accepts explicit type:message form', () => {
      const parsed = SendMessageInputSchema.parse({
        type: 'message',
        to: 'researcher',
        content: 'Hello',
        summary: '1-line preview',
      });
      expect(parsed.summary).toBe('1-line preview');
    });
  });

  describe('type: broadcast', () => {
    it('accepts {type, content} (no to)', () => {
      const parsed = SendMessageInputSchema.parse({
        type: 'broadcast',
        content: 'Critical: stop all work',
      });
      expect(parsed.type).toBe('broadcast');
    });
    it('rejects broadcast with to field (broadcast has no recipient)', () => {
      expect(() => SendMessageInputSchema.parse({
        type: 'broadcast',
        to: 'researcher',
        content: 'oops',
      })).toThrow();
    });
  });

  describe('type: shutdown_request', () => {
    it('accepts {type, to, content}', () => {
      const parsed = SendMessageInputSchema.parse({
        type: 'shutdown_request',
        to: 'researcher',
        content: 'wrap up',
      });
      expect(parsed.type).toBe('shutdown_request');
    });
  });

  describe('type: shutdown_response', () => {
    it('accepts {type, request_id, approve}', () => {
      const parsed = SendMessageInputSchema.parse({
        type: 'shutdown_response',
        request_id: 'msg-abc',
        approve: true,
      });
      expect(parsed.approve).toBe(true);
    });
    it('accepts approve:false with content', () => {
      const parsed = SendMessageInputSchema.parse({
        type: 'shutdown_response',
        request_id: 'msg-abc',
        approve: false,
        content: 'need 5 more minutes',
      });
      expect(parsed.content).toBe('need 5 more minutes');
    });
  });

  describe('type: plan_approval_response', () => {
    it('accepts {type, request_id, to, approve}', () => {
      const parsed = SendMessageInputSchema.parse({
        type: 'plan_approval_response',
        request_id: 'msg-xyz',
        to: 'researcher',
        approve: true,
      });
      expect(parsed.approve).toBe(true);
    });
  });

  describe('forbidden types not in schema', () => {
    it('rejects type: task_notification (system-only)', () => {
      expect(() => SendMessageInputSchema.parse({
        type: 'task_notification',
        to: 'lead',
        content: '<task-notification>...</task-notification>',
      })).toThrow();
    });
    it('rejects type: tick (system-only)', () => {
      expect(() => SendMessageInputSchema.parse({
        type: 'tick',
        to: 'lead',
        content: '...',
      })).toThrow();
    });
  });
});
```

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/tools/SendMessageTool/__tests__/discriminated-union.test.ts
```

Expected: FAIL — current schema is flat, not a discriminated union.

- [ ] **Step 3: Replace `SendMessageInputSchema` with discriminated union**

In `src/tools/SendMessageTool/SendMessageTool.ts`, replace the existing `SendMessageInputSchema` (around lines 61-68) with:

```ts
// Phase C: 5-variant discriminated union per Agent Teams spec §4.1.
// Backward compat: bare {to, message} (no type) is treated as
// type='message' via preprocessor — preserves existing call sites in
// team-run.ts and the API routes.

const messageVariant = z.object({
  type: z.literal('message'),
  to: z.string().min(1),
  // content is the new canonical name; legacy callers used `message` —
  // the preprocessor maps `message` → `content` for back-compat.
  content: z.string().min(1),
  summary: z.string().optional(),
  run_id: z.string().optional(),
});

const broadcastVariant = z.object({
  type: z.literal('broadcast'),
  content: z.string().min(1),
  summary: z.string().optional(),
  run_id: z.string().optional(),
}).strict();

const shutdownRequestVariant = z.object({
  type: z.literal('shutdown_request'),
  to: z.string().min(1),
  content: z.string().min(1),
  summary: z.string().optional(),
  run_id: z.string().optional(),
});

const shutdownResponseVariant = z.object({
  type: z.literal('shutdown_response'),
  request_id: z.string().min(1),
  approve: z.boolean(),
  content: z.string().optional(),
  run_id: z.string().optional(),
});

const planApprovalResponseVariant = z.object({
  type: z.literal('plan_approval_response'),
  request_id: z.string().min(1),
  to: z.string().min(1),
  approve: z.boolean(),
  content: z.string().optional(),
  run_id: z.string().optional(),
});

// Preprocessor: inject type='message' for legacy {to, message} callers.
// Also map `message` field → `content` so legacy callers don't break.
export const SendMessageInputSchema = z.preprocess(
  (raw) => {
    if (raw === null || typeof raw !== 'object') return raw;
    const obj = raw as Record<string, unknown>;
    if (obj.type === undefined) {
      // Legacy form: ensure type='message' AND map message→content.
      const next = { ...obj, type: 'message' };
      if (next.message !== undefined && next.content === undefined) {
        next.content = next.message;
        delete next.message;
      }
      return next;
    }
    return raw;
  },
  z.discriminatedUnion('type', [
    messageVariant,
    broadcastVariant,
    shutdownRequestVariant,
    shutdownResponseVariant,
    planApprovalResponseVariant,
  ]),
);

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;
```

Keep the `SendMessageResult` interface unchanged for now — Task 2 may evolve it.

- [ ] **Step 4: Run — verify pass**

```bash
pnpm vitest run src/tools/SendMessageTool/__tests__/discriminated-union.test.ts
```

Expected: PASS (10 cases).

- [ ] **Step 5: Run existing SendMessageTool tests for regression**

```bash
pnpm vitest run src/tools/SendMessageTool
```

Expected: existing tests still PASS — preprocessor handles legacy callers transparently. If a test fails because it asserted on the OLD `input.message` field name, update the assertion to `input.content`.

- [ ] **Step 6: Typecheck**

```bash
pnpm tsc --noEmit --pretty false
```

Expected: zero errors. The discriminated union changes the inferred TaskInput type — if any consumer of `SendMessageInput` accesses `.message` directly, fix to `.content`.

- [ ] **Step 7: Commit**

```bash
git add src/tools/SendMessageTool/SendMessageTool.ts \
        src/tools/SendMessageTool/__tests__/discriminated-union.test.ts
git commit -m "feat(SendMessage): 5-variant discriminated union schema (Phase C)"
```

---

## Task 2: SendMessage — execute() dispatch by variant

**Files:**
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts` (rewrite execute() body)
- Test: `src/tools/SendMessageTool/__tests__/SendMessageTool.test.ts` (extend with per-variant assertions)

Replace the single-path execute() with a switch over `input.type`. Each variant inserts a different `team_messages` shape; broadcast fans out to all team members; shutdown_request adds a wake() call on the recipient.

- [ ] **Step 1: Add failing tests for variant-specific behavior**

Append to `src/tools/SendMessageTool/__tests__/SendMessageTool.test.ts`:

```ts
describe('SendMessage execute() — variant dispatch', () => {
  it('type:message inserts a single team_messages row', async () => {
    // ... mock db setup ...
    const result = await sendMessageTool.execute(
      { type: 'message', to: 'researcher', content: 'Hello' },
      ctx,
    );
    expect(result.delivered).toBe(true);
    expect(insertSpy).toHaveBeenCalledOnce();
  });

  it('type:broadcast fans out to all team members (except sender)', async () => {
    // mock db with 3 team_members; insert should be called 2 times (excluding sender)
    await sendMessageTool.execute(
      { type: 'broadcast', content: 'Critical' },
      ctx,
    );
    expect(insertSpy).toHaveBeenCalledTimes(2);
  });

  it('type:shutdown_request inserts row + calls wake on recipient', async () => {
    await sendMessageTool.execute(
      { type: 'shutdown_request', to: 'researcher', content: 'wrap up' },
      ctx,
    );
    expect(insertSpy).toHaveBeenCalledOnce();
    expect(wakeSpy).toHaveBeenCalledWith(expect.stringContaining('researcher'));
  });

  it('type:shutdown_response inserts row with replies_to_id', async () => {
    await sendMessageTool.execute(
      {
        type: 'shutdown_response',
        request_id: 'orig-msg-id',
        approve: false,
        content: 'need 5 more',
      },
      ctx,
    );
    const insertedValues = insertSpy.mock.calls[0][0];
    expect(insertedValues.repliesToId).toBe('orig-msg-id');
  });

  it('type:plan_approval_response inserts row with replies_to_id and to', async () => {
    await sendMessageTool.execute(
      {
        type: 'plan_approval_response',
        request_id: 'plan-msg-id',
        to: 'researcher',
        approve: true,
      },
      ctx,
    );
    const insertedValues = insertSpy.mock.calls[0][0];
    expect(insertedValues.repliesToId).toBe('plan-msg-id');
    expect(insertedValues.toAgentId).toBeTruthy();
  });
});
```

(Adjust mock setup to match the existing test file's helpers.)

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/tools/SendMessageTool/__tests__/SendMessageTool.test.ts -t 'variant dispatch'
```

- [ ] **Step 3: Refactor execute() body**

In `SendMessageTool.ts`, replace the existing execute() body (around line 218) with:

```ts
async execute(input, ctx): Promise<SendMessageResult> {
  const { teamId, currentMemberId, runId, db } = readTeamContext(ctx);

  switch (input.type) {
    case 'message':
      return await dispatchMessage(input, { teamId, currentMemberId, runId, db });
    case 'broadcast':
      return await dispatchBroadcast(input, { teamId, currentMemberId, runId, db });
    case 'shutdown_request':
      return await dispatchShutdownRequest(input, { teamId, currentMemberId, runId, db });
    case 'shutdown_response':
      return await dispatchShutdownResponse(input, { teamId, currentMemberId, runId, db });
    case 'plan_approval_response':
      return await dispatchPlanApprovalResponse(input, { teamId, currentMemberId, runId, db });
  }
},
```

Add the 5 dispatch helpers as module-level functions. Each follows the same shape:
1. Resolve recipient (if applicable) — name → memberId, OR memberId direct
2. Build the `team_messages` insert values with appropriate `messageType` + routing fields
3. Insert + (optionally) call `wake()`
4. Return `SendMessageResult`

Sample for `dispatchShutdownRequest`:

```ts
async function dispatchShutdownRequest(
  input: Extract<SendMessageInput, { type: 'shutdown_request' }>,
  deps: { teamId: string; currentMemberId: string | null; runId: string | null; db: Database },
): Promise<SendMessageResult> {
  const { teamId, currentMemberId, runId, db } = deps;
  const toMemberId = await resolveRecipient(input.to, teamId, db);
  const messageId = crypto.randomUUID();
  await db.insert(teamMessages).values({
    id: messageId,
    teamId,
    runId: runId ?? null,
    type: 'user_prompt',
    messageType: 'shutdown_request',
    fromMemberId: currentMemberId,
    toMemberId,
    content: input.content,
    summary: input.summary ?? null,
  });
  // Wake the target so it drains the request at next idle turn (or right now).
  await wake(toMemberId);  // NOTE: in Phase C, toMemberId is treated as agentId surrogate; Phase E proper agent_runs routing
  await publishToRedis(teamId, { messageId, type: 'shutdown_request', toMemberId });
  return { delivered: true, messageId, toMemberId };
}
```

The other 4 dispatchers follow the same pattern with their respective shapes.

For `dispatchBroadcast`:
- Query `teamMembers` for all team members in current teamId
- Filter out current sender
- Insert one row per recipient with `messageType: 'broadcast'`, `toMemberId: <recipient>`, content the same
- Return `{ delivered: true, messageId: <first-inserted>, toMemberId: <first> }` (broadcasts have no single recipient — return the first for compat)

Add the import:
```ts
import { wake } from '@/workers/processors/lib/wake';
```

- [ ] **Step 4: Run tests — verify pass**

```bash
pnpm vitest run src/tools/SendMessageTool
```

Expected: all PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/tools/SendMessageTool/SendMessageTool.ts \
        src/tools/SendMessageTool/__tests__/SendMessageTool.test.ts
git commit -m "feat(SendMessage): execute() dispatch by variant (Phase C)"
```

---

## Task 3: SendMessage — runtime validation (lead-only + rate-limit)

**Files:**
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts` (add `validateInput()`)
- Test: `src/tools/SendMessageTool/__tests__/SendMessageTool.test.ts` (extend)

Add `validateInput()` to enforce two architectural rules:
1. `plan_approval_response` is lead-only (caller's `agent_runs.role === 'lead'`)
2. `broadcast` is rate-limited to 1 per turn (best-effort: query DB for prior broadcasts in last 5 seconds from same fromMemberId)

- [ ] **Step 1: Add failing tests**

```ts
describe('SendMessage validateInput — Phase C runtime checks', () => {
  it('rejects plan_approval_response when caller is not lead', async () => {
    const ctx = makeMemberCtx(); // role='member'
    const result = await sendMessageTool.validateInput!(
      {
        type: 'plan_approval_response',
        request_id: 'plan-1',
        to: 'researcher',
        approve: true,
      },
      ctx,
    );
    expect(result.result).toBe(false);
    if (!result.result) {
      expect(result.message).toMatch(/lead/i);
      expect(result.errorCode).toBe(403);
    }
  });

  it('accepts plan_approval_response when caller is lead', async () => {
    const ctx = makeLeadCtx(); // role='lead'
    const result = await sendMessageTool.validateInput!(
      {
        type: 'plan_approval_response',
        request_id: 'plan-1',
        to: 'researcher',
        approve: true,
      },
      ctx,
    );
    expect(result.result).toBe(true);
  });

  it('rejects broadcast when caller already broadcast in last 5s', async () => {
    // mock DB to return 1 prior broadcast row
    const ctx = makeMemberCtxWithRecentBroadcast();
    const result = await sendMessageTool.validateInput!(
      { type: 'broadcast', content: 'msg' },
      ctx,
    );
    expect(result.result).toBe(false);
    if (!result.result) {
      expect(result.message).toMatch(/rate.?limit/i);
      expect(result.errorCode).toBe(429);
    }
  });

  it('accepts broadcast when no recent broadcasts', async () => {
    const ctx = makeMemberCtxNoRecent();
    const result = await sendMessageTool.validateInput!(
      { type: 'broadcast', content: 'msg' },
      ctx,
    );
    expect(result.result).toBe(true);
  });
});
```

- [ ] **Step 2: Run — verify failure**

- [ ] **Step 3: Add `validateInput` to the tool definition**

In `SendMessageTool.ts`, add to the `buildTool({...})` call:

```ts
async validateInput(input, ctx): Promise<ValidationResult> {
  // 1. plan_approval_response is lead-only
  if (input.type === 'plan_approval_response') {
    const callerRole = await getCallerRole(ctx);
    if (callerRole !== 'lead') {
      return {
        result: false,
        errorCode: 403,
        message: 'plan_approval_response is restricted to team-lead. ' +
          'Only the lead can approve / reject teammate-submitted plans.',
      };
    }
  }
  // 2. broadcast rate limit: 1 per 5 seconds per sender
  if (input.type === 'broadcast') {
    const { teamId, currentMemberId, db } = readTeamContext(ctx);
    if (currentMemberId) {
      const recent = await countRecentBroadcasts(db, teamId, currentMemberId, 5);
      if (recent > 0) {
        return {
          result: false,
          errorCode: 429,
          message: 'broadcast is rate-limited to 1 per turn / 5 seconds. ' +
            'Use type:message (DM) for follow-up.',
        };
      }
    }
  }
  return { result: true };
},
```

Add helper functions:

```ts
async function getCallerRole(ctx: ToolContext): Promise<'lead' | 'member' | null> {
  // Phase C: read from ToolContext if injected; default to 'member' for safety
  // (i.e. fail-closed — caller must explicitly assert lead role).
  try {
    const role = ctx.get<'lead' | 'member'>('callerRole');
    return role;
  } catch {
    return null;
  }
}

async function countRecentBroadcasts(
  db: Database,
  teamId: string,
  fromMemberId: string,
  windowSeconds: number,
): Promise<number> {
  const since = new Date(Date.now() - windowSeconds * 1000);
  const rows = await db
    .select({ id: teamMessages.id })
    .from(teamMessages)
    .where(and(
      eq(teamMessages.teamId, teamId),
      eq(teamMessages.fromMemberId, fromMemberId),
      eq(teamMessages.messageType, 'broadcast'),
      gt(teamMessages.createdAt, since),
    ))
    .limit(1);
  return rows.length;
}
```

(`gt` from drizzle-orm — add to imports.)

**Note**: `getCallerRole` reads from a new ToolContext key `callerRole` that the calling code (team-run.ts, agent-run.ts) needs to inject. For Phase C MVP, if the key is absent, returns null and `plan_approval_response` is rejected (fail-closed). Phase E will wire this properly when the team-lead also runs as `agent_runs`.

- [ ] **Step 4: Run tests — verify pass**

```bash
pnpm vitest run src/tools/SendMessageTool
```

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/tools/SendMessageTool/SendMessageTool.ts \
        src/tools/SendMessageTool/__tests__/SendMessageTool.test.ts
git commit -m "feat(SendMessage): runtime validation — plan_approval_response lead-only + broadcast rate limit (Phase C)"
```

---

## Task 4: peer-DM-shadow helper

**Files:**
- Create: `src/workers/processors/lib/peer-dm-shadow.ts`
- Test: `src/workers/processors/lib/__tests__/peer-dm-shadow.test.ts`

Helper that inserts a summary-only "shadow" row to the lead's mailbox when teammate-to-teammate `message` is sent. **Critical invariant**: this function does NOT call `wake()` — the shadow is for low-cost transparency, not active notification.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { insertPeerDmShadow } from '@/workers/processors/lib/peer-dm-shadow';

vi.mock('@/workers/processors/lib/wake', () => ({
  wake: vi.fn(),
}));

import { wake } from '@/workers/processors/lib/wake';

describe('insertPeerDmShadow — Phase C', () => {
  it('inserts a shadow row addressed to leadAgentId', async () => {
    const insertSpy = vi.fn();
    const db = makeDbMock({ insertSpy });
    await insertPeerDmShadow({
      teamId: 'team-1',
      leadAgentId: 'lead-agent-id',
      fromName: 'researcher',
      toName: 'writer',
      summary: 'asking about citations',
      db: db as never,
    });
    expect(insertSpy).toHaveBeenCalledOnce();
    const inserted = insertSpy.mock.calls[0][0];
    expect(inserted.toAgentId).toBe('lead-agent-id');
    expect(inserted.messageType).toBe('message');
    expect(inserted.content).toContain('<peer-dm');
    expect(inserted.content).toContain('researcher');
    expect(inserted.content).toContain('writer');
    expect(inserted.content).toContain('asking about citations');
  });

  it('CRITICAL INVARIANT: does NOT call wake()', async () => {
    vi.mocked(wake).mockClear();
    const db = makeDbMock();
    await insertPeerDmShadow({
      teamId: 'team-1',
      leadAgentId: 'lead-agent-id',
      fromName: 'a',
      toName: 'b',
      summary: 's',
      db: db as never,
    });
    expect(wake).not.toHaveBeenCalled();
  });

  it('skips insert when leadAgentId is null (Phase B kludge — lead has no agent_runs row yet)', async () => {
    const insertSpy = vi.fn();
    const db = makeDbMock({ insertSpy });
    await insertPeerDmShadow({
      teamId: 'team-1',
      leadAgentId: null,
      fromName: 'a',
      toName: 'b',
      summary: 's',
      db: db as never,
    });
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

function makeDbMock(opts: { insertSpy?: ReturnType<typeof vi.fn> } = {}) {
  const insertSpy = opts.insertSpy ?? vi.fn();
  return {
    insert: vi.fn(() => ({
      values: vi.fn(async (vals: unknown) => insertSpy(vals)),
    })),
  };
}
```

- [ ] **Step 2: Run — verify failure**

- [ ] **Step 3: Implement `peer-dm-shadow.ts`**

```ts
// peer-DM-shadow helper — engine PDF §3.6.1 channel ③.
//
// When teammate-to-teammate `type:message` is sent, also insert a
// summary-only shadow row to the lead's mailbox. This gives the lead
// "I see what peers are talking about" visibility WITHOUT actively
// waking the lead — a key engine invariant: peer DMs must not generate
// scheduling pressure on the lead.
//
// Phase B kludge: if the lead has no agent_runs row yet (leadAgentId
// is null), skip the insert. The lead's polling drain in team-run will
// naturally pick up these shadows when wired in Phase E (X model).

import { teamMessages } from '@/lib/db/schema';
import type { Database } from '@/lib/db';

const SYSTEM_AGENT_ID = '__system__';

export interface PeerDmShadowInput {
  teamId: string;
  leadAgentId: string | null;
  fromName: string;
  toName: string;
  summary: string;
  db: Database;
}

/**
 * Insert a peer-DM visibility shadow row to the lead's mailbox.
 *
 * **Architecture-critical invariant**: this function MUST NOT call
 * `wake()`. Peer DMs shall not preemptively wake the lead — the lead
 * sees these shadows on its NEXT natural wake (task notification or
 * founder message). Removing this invariant is a review-reject.
 */
export async function insertPeerDmShadow({
  teamId,
  leadAgentId,
  fromName,
  toName,
  summary,
  db,
}: PeerDmShadowInput): Promise<void> {
  if (leadAgentId === null) {
    // Phase B kludge: lead has no agent_runs row yet. Phase E lifts this.
    return;
  }
  await db.insert(teamMessages).values({
    teamId,
    type: 'user_prompt',
    messageType: 'message',
    fromAgentId: SYSTEM_AGENT_ID,
    toAgentId: leadAgentId,
    content: `<peer-dm from="${fromName}" to="${toName}">${escapePeerDmContent(summary)}</peer-dm>`,
    summary,
  });
  // CRITICAL: no wake() call here. See JSDoc above.
}

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escapePeerDmContent(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}
```

- [ ] **Step 4: Run — verify pass**

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/workers/processors/lib/peer-dm-shadow.ts \
        src/workers/processors/lib/__tests__/peer-dm-shadow.test.ts
git commit -m "feat(workers/lib): peer-dm-shadow — summary visibility for lead, no wake (Phase C)"
```

---

## Task 5: SendMessage — wire peer-DM shadow

**Files:**
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts` (call insertPeerDmShadow in dispatchMessage)

When `type:message` is sent AND fromAgentId is a teammate AND toAgentId is a teammate (not lead), also insert a peer-DM shadow.

- [ ] **Step 1: Add a test in SendMessageTool.test.ts that asserts shadow insertion for peer DMs**

```ts
it('teammate→teammate message also inserts a peer-DM shadow', async () => {
  // ctx with fromAgentId = teammate A, recipient = teammate B (not lead)
  // mock the lead lookup to return leadAgentId
  await sendMessageTool.execute(
    { type: 'message', to: 'teammate-b', content: 'hey', summary: 'asking q' },
    teammateCtx,
  );
  expect(insertSpy).toHaveBeenCalledTimes(2); // primary + shadow
  const shadowInsert = insertSpy.mock.calls[1][0];
  expect(shadowInsert.content).toContain('<peer-dm');
});

it('teammate→lead message does NOT insert a peer-DM shadow (lead is the recipient already)', async () => {
  await sendMessageTool.execute(
    { type: 'message', to: 'lead', content: 'status update' },
    teammateCtx,
  );
  expect(insertSpy).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Wire `insertPeerDmShadow` into `dispatchMessage`**

In `SendMessageTool.ts`, in `dispatchMessage`:

```ts
import { insertPeerDmShadow } from '@/workers/processors/lib/peer-dm-shadow';

async function dispatchMessage(input, deps) {
  // ... existing primary insert ...
  
  // Phase C: peer-DM visibility — only when both ends are teammates (not lead).
  // Lookup caller role + recipient role; only insert shadow when both are 'member'.
  const fromRole = await getCallerRole(deps.ctx);
  const toRole = await getRoleOfMember(toMemberId, deps.db);
  if (fromRole === 'member' && toRole === 'member') {
    const leadAgentId = await getLeadAgentId(deps.teamId, deps.db); // null in Phase B
    await insertPeerDmShadow({
      teamId: deps.teamId,
      leadAgentId,
      fromName: await getMemberName(deps.currentMemberId, deps.db),
      toName: await getMemberName(toMemberId, deps.db),
      summary: input.summary ?? input.content.slice(0, 80),
      db: deps.db,
    });
  }
  
  return { delivered: true, messageId, toMemberId };
}
```

Add helpers for `getRoleOfMember`, `getLeadAgentId`, `getMemberName` (each is a one-line query).

- [ ] **Step 3: Run tests — verify pass**

- [ ] **Step 4: Typecheck + commit**

```bash
git add src/tools/SendMessageTool/SendMessageTool.ts \
        src/tools/SendMessageTool/__tests__/SendMessageTool.test.ts
git commit -m "feat(SendMessage): wire peer-DM shadow on teammate↔teammate messages (Phase C)"
```

---

## Task 6: TaskStop tool

**Files:**
- Create: `src/tools/TaskStopTool/TaskStopTool.ts`
- Test: `src/tools/TaskStopTool/__tests__/TaskStopTool.test.ts`
- Modify: `src/tools/registry.ts` or `src/tools/registry-team.ts` (register the tool)
- Modify: `src/tools/AgentTool/blacklists.ts` (add TASK_STOP_TOOL_NAME to INTERNAL_TEAMMATE_TOOLS)

The `TaskStop` tool: input `{task_id}` (= agent_runs.id). Effect: insert a `shutdown_request` row to the teammate's mailbox; mark `agent_runs.status='killed'`; cancel the BullMQ job (best-effort).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { taskStopTool, TASK_STOP_TOOL_NAME } from '@/tools/TaskStopTool/TaskStopTool';

vi.mock('@/workers/processors/lib/wake', () => ({ wake: vi.fn() }));

describe('TaskStop tool — Phase C', () => {
  it('inserts shutdown_request row for the target agentId', async () => {
    const insertSpy = vi.fn();
    const ctx = makeLeadCtx({ insertSpy });
    await taskStopTool.execute({ task_id: 'agent-target' }, ctx);
    expect(insertSpy).toHaveBeenCalledOnce();
    const row = insertSpy.mock.calls[0][0];
    expect(row.messageType).toBe('shutdown_request');
    expect(row.toAgentId).toBe('agent-target');
  });

  it('calls wake on target so it processes shutdown_request promptly', async () => {
    const ctx = makeLeadCtx();
    await taskStopTool.execute({ task_id: 'agent-target' }, ctx);
    const { wake } = await import('@/workers/processors/lib/wake');
    expect(vi.mocked(wake)).toHaveBeenCalledWith('agent-target');
  });

  it('marks agent_runs.status=killed', async () => {
    const updateSpy = vi.fn();
    const ctx = makeLeadCtx({ updateSpy });
    await taskStopTool.execute({ task_id: 'agent-target' }, ctx);
    expect(updateSpy).toHaveBeenCalled();
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ status: 'killed' });
  });

  it('rejects when caller is not lead', async () => {
    const ctx = makeMemberCtx();
    const result = await taskStopTool.validateInput!({ task_id: 'agent-target' }, ctx);
    expect(result.result).toBe(false);
    if (!result.result) expect(result.errorCode).toBe(403);
  });

  it('exports the canonical name', () => {
    expect(TASK_STOP_TOOL_NAME).toBe('TaskStop');
  });
});
```

- [ ] **Step 2: Implement `TaskStopTool.ts`**

```ts
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition, ToolContext, ValidationResult } from '@/core/types';
import { db as defaultDb, type Database } from '@/lib/db';
import { agentRuns, teamMessages } from '@/lib/db/schema';
import { wake } from '@/workers/processors/lib/wake';

export const TASK_STOP_TOOL_NAME = 'TaskStop';

export const TaskStopInputSchema = z.object({
  task_id: z.string().min(1, 'task_id is required (= agent_runs.id of the teammate to stop)'),
}).strict();

export type TaskStopInput = z.infer<typeof TaskStopInputSchema>;

export interface TaskStopResult {
  stopped: true;
  task_id: string;
}

function readDeps(ctx: ToolContext): { db: Database; teamId: string; fromMemberId: string | null } {
  let db = defaultDb;
  try { db = ctx.get<Database>('db'); } catch { /* default */ }
  const teamId = ctx.get<string>('teamId');
  let fromMemberId: string | null = null;
  try { fromMemberId = ctx.get<string>('currentMemberId'); } catch { /* null */ }
  return { db, teamId, fromMemberId };
}

async function getCallerRole(ctx: ToolContext): Promise<'lead' | 'member' | null> {
  try { return ctx.get<'lead' | 'member'>('callerRole'); }
  catch { return null; }
}

export const taskStopTool: ToolDefinition<TaskStopInput, TaskStopResult> = buildTool({
  name: TASK_STOP_TOOL_NAME,
  description:
    'Stop a running teammate gracefully. Writes a shutdown_request to the ' +
    'target\'s mailbox (the teammate processes it on its next idle turn and ' +
    'exits cleanly), marks agent_runs.status=killed, and cancels the BullMQ job. ' +
    'Lead-only — teammates cannot stop peers.',
  inputSchema: TaskStopInputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  isDestructive: () => true,
  async validateInput(input, ctx): Promise<ValidationResult> {
    const role = await getCallerRole(ctx);
    if (role !== 'lead') {
      return {
        result: false,
        errorCode: 403,
        message: 'TaskStop is restricted to team-lead. Teammates cannot stop peers.',
      };
    }
    return { result: true };
  },
  async execute(input, ctx): Promise<TaskStopResult> {
    const { db, teamId, fromMemberId } = readDeps(ctx);

    // 1. Insert shutdown_request to target's mailbox
    await db.insert(teamMessages).values({
      teamId,
      type: 'user_prompt',
      messageType: 'shutdown_request',
      fromMemberId,
      toAgentId: input.task_id,
      content: 'Stop requested by team-lead. Wrap up gracefully and exit.',
      summary: 'TaskStop',
    });

    // 2. Mark agent_runs.status=killed
    await db.update(agentRuns)
      .set({ status: 'killed', shutdownReason: 'TaskStop by lead', lastActiveAt: new Date() })
      .where(eq(agentRuns.id, input.task_id));

    // 3. Wake the target so it processes the shutdown promptly
    await wake(input.task_id);

    return { stopped: true, task_id: input.task_id };
  },
});
```

- [ ] **Step 3: Add to INTERNAL_TEAMMATE_TOOLS in blacklists.ts**

```ts
import { TASK_STOP_TOOL_NAME } from '@/tools/TaskStopTool/TaskStopTool';

export const INTERNAL_TEAMMATE_TOOLS: ReadonlySet<string> = new Set([
  TASK_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,  // NEW (Phase C)
]);
```

- [ ] **Step 4: Register the tool in `src/tools/registry-team.ts`** (or registry.ts — match where SendMessageTool is registered)

```ts
import { taskStopTool } from '@/tools/TaskStopTool/TaskStopTool';

export function registerDeferredTools(...) {
  // existing
  registry.register(taskStopTool);
}
```

- [ ] **Step 5: Run tests — verify pass**

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/tools/TaskStopTool/ \
        src/tools/AgentTool/blacklists.ts \
        src/tools/registry-team.ts
git commit -m "feat(TaskStop): lead-only stop tool + add to INTERNAL_TEAMMATE_TOOLS (Phase C)"
```

---

## Task 7: agent-run — idle-turn drain + shutdown_request graceful exit

**Files:**
- Modify: `src/workers/processors/agent-run.ts`
- Test: `src/workers/processors/__tests__/agent-run.test.ts`

Hook a mailbox-drain call into the agent-run processor's runAgent loop, between turns. If the drained batch contains a `shutdown_request`, exit gracefully (mark status='killed', synthesize notification with status='killed').

- [ ] **Step 1: Add failing tests**

```ts
it('drains mailbox at idle-turn boundary and injects messages into transcript', async () => {
  // mock drainMailbox to return one message; assert runAgent is called with
  // a transcript that includes the message body
  ...
});

it('on shutdown_request received, exits gracefully with status=killed', async () => {
  // mock drainMailbox to return [{ messageType: 'shutdown_request', ... }]
  await processAgentRun(makeJob('agent-target'));
  expect(updateSpy.mock.calls.some((c) => c[0].status === 'killed')).toBe(true);
  expect(synthesizeSpy.mock.calls[0][0].status).toBe('killed');
});
```

- [ ] **Step 2: Extend agent-run processor**

In `src/workers/processors/agent-run.ts`, modify the runAgent loop. Look for an `onIdleReset` or similar callback. Add:

```ts
import { drainMailbox } from './lib/mailbox-drain';

// ... in processAgentRun, after the initial drainMailbox call ...

// Phase C: drain mailbox between turns
async function onIdleTurn(): Promise<{ shouldExit: boolean }> {
  const batch = await drainMailbox(agentId, db);
  if (batch.length === 0) return { shouldExit: false };
  
  const hasShutdown = batch.some((m) => m.messageType === 'shutdown_request');
  if (hasShutdown) {
    return { shouldExit: true };
  }
  // Inject batch as user-role transcript entries before next assistant call
  // ... (implementation depends on runAgent's hook surface)
  return { shouldExit: false };
}

// Pass onIdleTurn as a callback into runAgent (or wrap the loop manually)
// ...

// On graceful exit due to shutdown_request:
if (gracefullyKilled) {
  status = 'killed';
  summary = 'Stopped by TaskStop';
}
```

The exact integration depends on runAgent's hook surface — look at `team-run.ts` for the pattern used for user-message injection (Phase B Task 12 added a similar drain mechanism). Reuse that pattern.

- [ ] **Step 3: Run tests — verify pass**

- [ ] **Step 4: Typecheck + commit**

```bash
git add src/workers/processors/agent-run.ts \
        src/workers/processors/__tests__/agent-run.test.ts
git commit -m "feat(agent-run): idle-turn mailbox drain + shutdown_request graceful exit (Phase C)"
```

---

## Task 8: Verification gate

- [ ] **Step 1: Run full Phase C test sweep**

```bash
pnpm vitest run src/tools/SendMessageTool \
                src/tools/TaskStopTool \
                src/workers/processors/lib/__tests__/peer-dm-shadow.test.ts \
                src/workers/processors/__tests__/agent-run.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run full AgentTool sweep + Phase B sweep for regression**

```bash
pnpm vitest run src/tools/AgentTool src/lib/feature-flags src/workers/processors/lib
```

Expected: 80+ tests still PASS (no Phase A or B regression).

- [ ] **Step 3: Full project test sweep**

```bash
pnpm test 2>&1 | tail -40
```

Expected: 885+ pass, no new red.

- [ ] **Step 4: Typecheck**

```bash
pnpm tsc --noEmit --pretty false
```

Expected: clean.

- [ ] **Step 5: Tag the milestone**

```bash
git tag -a phase-c-sendmessage-protocol -m "Agent Teams Phase C — SendMessage protocol complete"
```

- [ ] **Step 6: Update spec doc with Phase C landed entry + commit SHAs**

Append to `docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md`:

```markdown
- **Phase C — SendMessage protocol:** landed `2026-05-02` on `dev`. SendMessageTool
  is now a 5-variant discriminated union (message / broadcast / shutdown_request /
  shutdown_response / plan_approval_response) with backward-compat preprocessor
  for the legacy {to, message} shape. Runtime validation: plan_approval_response
  is lead-only (403); broadcast is rate-limited to 1 per 5 seconds (429).
  TaskStop tool added (lead-only; writes shutdown_request + kills agent_runs row +
  cancels BullMQ job). Peer-DM-shadow helper inserts visibility shadow to lead's
  mailbox WITHOUT calling wake (engine PDF §3.6.1 invariant). Agent-run processor
  drains mailbox at idle turns; shutdown_request triggers graceful exit with
  status='killed' notification.
  - Task 1 — discriminated union schema: <SHA>
  - Task 2 — execute() variant dispatch: <SHA>
  - Task 3 — runtime validation: <SHA>
  - Task 4 — peer-dm-shadow helper: <SHA>
  - Task 5 — SendMessage wires peer-DM shadow: <SHA>
  - Task 6 — TaskStop tool: <SHA>
  - Task 7 — agent-run drain + shutdown handler: <SHA>
  - Task 8 — verification gate: <SHA>
```

- [ ] **Step 7: Commit doc update**

```bash
git add docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md
git commit -m "docs(spec): mark Agent Teams Phase C landed"
```

---

## Acceptance criteria

- [ ] `SendMessageInputSchema` is a 5-variant discriminated union with type='message' default
- [ ] All 5 variants insert appropriate `team_messages` rows
- [ ] broadcast fans out to all team members except sender
- [ ] plan_approval_response is rejected (403) when caller is not lead
- [ ] broadcast is rate-limited (429) when caller broadcast in last 5s
- [ ] peer-DM-shadow helper inserts shadow when teammate→teammate, NEVER calls wake
- [ ] TaskStop tool is lead-only (403); inserts shutdown_request; marks agent_runs.status=killed; calls wake on target
- [ ] TASK_STOP_TOOL_NAME is in INTERNAL_TEAMMATE_TOOLS
- [ ] agent-run processor drains mailbox at idle turns; on shutdown_request, exits with status='killed'
- [ ] All Phase A + B tests still green; Phase C tests green
- [ ] `pnpm tsc --noEmit` clean
- [ ] Spec doc has Phase C landed timestamp + 8 commit SHAs
- [ ] Local tag `phase-c-sendmessage-protocol`

---

## Self-review notes

1. **Spec coverage**: every Phase C row in spec §6 maps to a task above.
2. **Type consistency**: `SendMessageInput` is the discriminated union type; existing call sites that read `input.message` need to be migrated to `input.content` (preprocessor handles wire-level back-compat, but code that destructures may need updates).
3. **Phase C carryovers**: `getCallerRole` reads from a ToolContext key that team-run.ts and agent-run.ts must inject. If not injected, returns null and lead-only operations fail closed (correct fail-mode for Phase C).
4. **The peer-DM `<peer-dm>` shadow XML format** is a Phase C invention (engine PDF doesn't specify the exact tag) — keeping it simple as an XML element so downstream consumers can parse easily.
5. **`SYSTEM_AGENT_ID = '__system__'`** is a sentinel. The DB FK on `from_agent_id → agent_runs.id` (if any) would reject this — verify the column has no FK constraint, OR insert NULL instead and document the fromAgentId convention. Phase B's schema declared `from_agent_id text` without `.references()` so this is fine.
