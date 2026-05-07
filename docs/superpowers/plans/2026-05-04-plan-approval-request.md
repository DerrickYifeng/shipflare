# plan_approval_request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the engine's plan-approval handshake by adding the **request** side. Today, [`SendMessageTool.ts:766`](../../src/tools/SendMessageTool/SendMessageTool.ts#L766) only dispatches `plan_approval_response` (the lead's verdict) — there's no way for a member to **submit** a plan and wait for the verdict. This plan adds: SendMessage variant `plan_approval_request`, lead-side approval UI in `/team`, member-side wait-then-resume lifecycle. Closes Tier-1 gap #3 from the agent-team gap roadmap.

**Architecture:**
1. **Extend SendMessage's discriminated `StructuredMessage` union** with a `plan_approval_request` variant carrying `{ planSummary: string, planDetails?: string }`. Mirrors engine `engine/tools/SendMessageTool/prompt.ts` protocol block.
2. **Member sends plan, ends turn.** Member calls SendMessage with `to: 'coordinator', message: { type: 'plan_approval_request', planSummary, planDetails }`. Tool inserts `team_messages` row with `messageType='plan_approval_request'`, returns sync. Member ends its turn (or calls Sleep) — its agent_runs row goes `sleeping`. The lead's mailbox drain picks up the request on its next wake.
3. **Lead approves/rejects via existing `plan_approval_response` dispatcher.** That code path already exists ([`SendMessageTool.ts:766`](../../src/tools/SendMessageTool/SendMessageTool.ts#L766)) — it inserts the response row and `wake()`s the requesting member. The wake delivers the response into the member's mailbox at next drain.
4. **Founder UI:** when `messageType='plan_approval_request'` lands in the coordinator's thread, the founder sees an **inline ApprovalCard** with Approve / Reject + an optional feedback textarea (rejecting requires feedback). Submitting routes through `POST /api/team/plan-approval` which delegates to the coordinator's SendMessage (so the response carries `from_member_id = coordinator`, not `null = founder` — the audit trail says "the lead approved on the founder's behalf").
5. **Member-side resume:** the existing mailbox-drain + agent-run resume flow handles the response — no new lifecycle code. The response arrives as a normal user-role message; the member's AGENT.md teaches the pattern "after plan_approval_request, your next user message is the verdict".
6. **Engine-aligned constraint:** `plan_approval_request` is **member-only** (lead has nothing to ask itself for approval on). Mirror the existing lead-only check on `plan_approval_response` ([`SendMessageTool.ts:861-876`](../../src/tools/SendMessageTool/SendMessageTool.ts#L861-L876)).

**Tech Stack:**
- TypeScript / Zod (extending the discriminated union in `SendMessageTool`)
- Drizzle (no schema change — `messageType` column is text, `repliesToId` already exists for chaining)
- Next.js API route for the founder-UI approval submit
- React client component (`ApprovalCard`)
- Vitest unit tests, Playwright real-browser smoke

**Depends on:**
- `2026-05-03-merge-judging-and-share-slop-rules.md` (Plan 1)
- `2026-05-04-pipeline-to-tools.md` (Plan 2)
- `2026-05-04-collapse-to-social-media-manager.md` (Plan 3)
- `2026-05-04-ask-user-question-tool.md` (Plan 4) — reuses the same QuestionCard rendering + reducer-stitching pattern. **Land 4 first.**

---

## File map

**Created**
- `src/app/api/team/plan-approval/route.ts`
- `src/app/api/team/plan-approval/__tests__/route.test.ts`
- `src/app/(app)/team/_components/approval-card.tsx`
- `src/app/(app)/team/_components/__tests__/approval-card.test.tsx`
- `e2e/plan-approval-smoke.spec.ts`

**Modified**
- `src/tools/SendMessageTool/SendMessageTool.ts` (add `plan_approval_request` variant + `dispatchPlanApprovalRequest` + member-only validation)
- `src/tools/SendMessageTool/__tests__/SendMessageTool.test.ts` (cover the new dispatch path + member-only guard)
- `src/lib/db/schema/team.ts` (one comment-only edit — already noted `plan_approval_request` as reserved in Plan 4 Task 1; remove the "(reserved, not yet emitted)" qualifier)
- `src/tools/AgentTool/agents/social-media-manager/AGENT.md` (no tool list change — SendMessage already there; add a "when to ask for approval" reference)
- `src/tools/AgentTool/agents/social-media-manager/references/patterns-and-examples.md` (one new pattern: ask-then-batch)
- `src/tools/AgentTool/agents/coordinator/AGENT.md` (add a "you handle plan approvals on the founder's behalf" note)
- `src/app/(app)/team/_components/conversation-reducer.ts` (handle `messageType='plan_approval_request'` and `'plan_approval_response'` rows)
- `src/app/(app)/team/_components/conversation.tsx` (render `<ApprovalCard>` for request rows)
- `src/workers/processors/agent-run.ts` (NO change — the existing drain handles the response since it's a normal mailbox message; verify with a regression test only)
- `CLAUDE.md` (add `plan_approval_request` to the Skill Primitive section)

**Deleted**
- (none)

---

## Task 1: Extend SendMessage with plan_approval_request variant (TDD)

**Files:**
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts`
- Modify: `src/tools/SendMessageTool/__tests__/SendMessageTool.test.ts`

- [ ] **Step 1: Read the existing dispatch code**

```bash
sed -n '83,100p' src/tools/SendMessageTool/SendMessageTool.ts
sed -n '760,830p' src/tools/SendMessageTool/SendMessageTool.ts
```

The `StructuredMessage` discriminated union is at line 83. The existing `dispatchPlanApprovalResponse` is at line 766. The new variant + dispatcher mirrors that shape.

- [ ] **Step 2: Write failing tests for the new variant**

Add to `src/tools/SendMessageTool/__tests__/SendMessageTool.test.ts`:

```typescript
describe('SendMessage — plan_approval_request', () => {
  let teamId: string;
  let coordMemberId: string;
  let smmMemberId: string;
  let smmAgentRunId: string;
  let coordAgentRunId: string;

  beforeEach(async () => {
    teamId = crypto.randomUUID();
    coordMemberId = crypto.randomUUID();
    smmMemberId = crypto.randomUUID();
    smmAgentRunId = crypto.randomUUID();
    coordAgentRunId = crypto.randomUUID();
    await db.insert(teams).values({ id: teamId, ownerId: 'test-user' });
    await db.insert(teamMembers).values([
      { id: coordMemberId, teamId, agentType: 'coordinator', displayName: 'Coordinator', role: 'lead' },
      { id: smmMemberId, teamId, agentType: 'social-media-manager', displayName: 'Social Media Manager', role: 'member' },
    ]);
    await db.insert(agentRuns).values([
      { id: smmAgentRunId, teamId, memberId: smmMemberId, agentDefName: 'social-media-manager', status: 'running' },
      { id: coordAgentRunId, teamId, memberId: coordMemberId, agentDefName: 'coordinator', status: 'sleeping' },
    ]);
  });

  it('member can send plan_approval_request to lead', async () => {
    const ctx = makeMockToolContext({
      teamId,
      currentMemberId: smmMemberId,
      runId: smmAgentRunId,
      callerRole: 'member',
    });
    const result = await sendMessageTool.execute(
      {
        to: 'Coordinator',
        message: {
          type: 'plan_approval_request',
          planSummary: 'Draft 5 posts about competitor X comparison',
          planDetails: 'Will use confident voice; cite specific feature gaps.',
        },
      },
      ctx,
    );
    expect(result.delivered).toBe(true);

    const rows = await db
      .select()
      .from(teamMessages)
      .where(eq(teamMessages.id, result.messageId))
      .limit(1);
    expect(rows[0].messageType).toBe('plan_approval_request');
    expect(rows[0].type).toBe('user_prompt');
    expect(rows[0].fromMemberId).toBe(smmMemberId);
    expect(rows[0].toMemberId).toBe(coordMemberId);
    expect(rows[0].toAgentId).toBe(coordAgentRunId);
    expect(rows[0].content).toContain('competitor X');
    expect(rows[0].metadata).toMatchObject({
      planSummary: 'Draft 5 posts about competitor X comparison',
      planDetails: 'Will use confident voice; cite specific feature gaps.',
    });
  });

  it('rejects plan_approval_request from lead (members-only)', async () => {
    const ctx = makeMockToolContext({
      teamId,
      currentMemberId: coordMemberId,
      runId: coordAgentRunId,
      callerRole: 'lead',
    });
    const result = await sendMessageTool.validateInput(
      {
        to: 'Social Media Manager',
        message: {
          type: 'plan_approval_request',
          planSummary: 'why would I ask myself',
        },
      },
      ctx,
    );
    expect(result.result).toBe(false);
    expect(result.errorCode).toBe(403);
    expect(result.message).toMatch(/member-only/i);
  });

  it('wakes the lead so it processes the request promptly', async () => {
    const wakeSpy = vi.spyOn(await import('@/workers/processors/lib/wake'), 'wake');
    const ctx = makeMockToolContext({
      teamId,
      currentMemberId: smmMemberId,
      runId: smmAgentRunId,
      callerRole: 'member',
    });
    await sendMessageTool.execute(
      {
        to: 'Coordinator',
        message: {
          type: 'plan_approval_request',
          planSummary: 'something',
        },
      },
      ctx,
    );
    expect(wakeSpy).toHaveBeenCalledWith(coordAgentRunId);
  });

  it('throws when target lead has no live agent_run', async () => {
    // Mark the coordinator's run as completed
    await db
      .update(agentRuns)
      .set({ status: 'completed' })
      .where(eq(agentRuns.id, coordAgentRunId));
    const ctx = makeMockToolContext({
      teamId,
      currentMemberId: smmMemberId,
      runId: smmAgentRunId,
      callerRole: 'member',
    });
    await expect(
      sendMessageTool.execute(
        {
          to: 'Coordinator',
          message: { type: 'plan_approval_request', planSummary: 'x' },
        },
        ctx,
      ),
    ).rejects.toThrow(/no active agent_run/i);
  });
});
```

(Reuse the existing `makeMockToolContext` helper in the test file; if it doesn't accept `callerRole`, extend it — the engine-style validation reads `callerRole` from the ctx Map.)

- [ ] **Step 3: Run tests, verify FAIL**

```bash
pnpm vitest run src/tools/SendMessageTool/__tests__/SendMessageTool.test.ts -t "plan_approval_request"
```

Expected: failures.

- [ ] **Step 4: Extend the discriminated union**

In `src/tools/SendMessageTool/SendMessageTool.ts`, find the `StructuredMessage` union (line 83). Add a fourth variant:

```typescript
const StructuredMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('shutdown_request'),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('shutdown_response'),
    request_id: z.string().min(1),
    approve: z.boolean(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('plan_approval_request'),
    planSummary: z
      .string()
      .min(1, 'planSummary is required')
      .max(280, 'planSummary must be 280 chars or fewer — keep it tweet-length'),
    planDetails: z
      .string()
      .max(2000, 'planDetails must be 2000 chars or fewer')
      .optional(),
  }),
  z.object({
    type: z.literal('plan_approval_response'),
    request_id: z.string().min(1),
    approve: z.boolean(),
    feedback: z.string().optional(),
  }),
]);
```

- [ ] **Step 5: Add member-only validation in `validateInput`**

In the same file, find `validateInput` (line ~861). Add a clause for `plan_approval_request`:

```typescript
async validateInput(input, ctx): Promise<ValidationResult> {
  // Existing plan_approval_response lead-only check stays as-is.
  if (
    typeof input.message === 'object' &&
    input.message.type === 'plan_approval_response'
  ) {
    const role = getCallerRole(ctx);
    if (role !== 'lead') {
      return {
        result: false,
        errorCode: 403,
        message:
          'plan_approval_response is restricted to team-lead. ' +
          'Only the lead can approve / reject teammate-submitted plans.',
      };
    }
  }

  // New: plan_approval_request is member-only.
  if (
    typeof input.message === 'object' &&
    input.message.type === 'plan_approval_request'
  ) {
    const role = getCallerRole(ctx);
    if (role !== 'member') {
      return {
        result: false,
        errorCode: 403,
        message:
          'plan_approval_request is member-only. ' +
          'The lead has no one to ask for approval — make the decision directly, ' +
          'or ask the founder via AskUserQuestion.',
      };
    }
  }

  // Existing broadcast rate-limit stays as-is.
  if (input.to === '*') { /* unchanged */ }

  return { result: true };
}
```

- [ ] **Step 6: Add the dispatcher**

After `dispatchPlanApprovalResponse` (line ~766), add:

```typescript
async function dispatchPlanApprovalRequest(
  input: SendMessageInput,
  structured: Extract<
    StructuredMessageInput,
    { type: 'plan_approval_request' }
  >,
  deps: DispatchDeps,
): Promise<SendMessageResult> {
  const { teamId, currentMemberId, runId, db } = deps;
  const toMemberId = await resolveRecipient(input.to, teamId, db);

  // Route by agent_runs.id, not team_members.id — wake() addresses runs, and
  // the recipient must have a live run to receive an ask.
  const targetAgentId = await resolveTargetAgentRun(toMemberId, db);
  if (targetAgentId === null) {
    throw new Error(
      `SendMessage plan_approval_request: no active agent_run for member ${toMemberId}. ` +
        `Recipient must be running or sleeping to receive plan approval requests.`,
    );
  }

  const effectiveRunId = input.run_id ?? runId ?? null;
  const messageId = crypto.randomUUID();
  const createdAt = new Date();

  // Human-readable content for log/grep surfaces. UI reads structured
  // payload from metadata.
  const content = structured.planDetails
    ? `${structured.planSummary}\n\n${structured.planDetails}`
    : structured.planSummary;

  await db.insert(teamMessages).values({
    id: messageId,
    runId: effectiveRunId,
    teamId,
    fromMemberId: currentMemberId,
    toMemberId,
    toAgentId: targetAgentId,
    type: 'user_prompt',
    messageType: 'plan_approval_request',
    content,
    summary: input.summary ?? structured.planSummary.slice(0, 80),
    metadata: {
      planSummary: structured.planSummary,
      planDetails: structured.planDetails ?? null,
    },
    createdAt,
  });

  // Wake the lead so it sees the request promptly. Lead's drain picks it
  // up at the next idle turn.
  await wake(targetAgentId);

  await publishToRedis(teamId, {
    messageId,
    runId: effectiveRunId,
    from: currentMemberId,
    to: toMemberId,
    content,
    metadata: {
      planSummary: structured.planSummary,
      planDetails: structured.planDetails ?? null,
    },
    createdAt: createdAt.toISOString(),
    type: 'user_prompt',
    messageType: 'plan_approval_request',
  });

  return { delivered: true, messageId, toMemberId };
}
```

- [ ] **Step 7: Wire the dispatcher into the execute switch**

In `execute()` (line ~901), the `switch (input.message.type)` block currently handles three types. Add the fourth:

```typescript
switch (input.message.type) {
  case 'shutdown_request':
    return dispatchShutdownRequest(input, input.message, deps);
  case 'shutdown_response':
    return dispatchShutdownResponse(input, input.message, deps);
  case 'plan_approval_request':
    return dispatchPlanApprovalRequest(input, input.message, deps);
  case 'plan_approval_response':
    return dispatchPlanApprovalResponse(input, input.message, deps);
}
```

- [ ] **Step 8: Update the tool description**

The tool's `description` field (~line 838) lists examples. Add a `plan_approval_request` example:

```typescript
description:
  'Send a message to another agent. ' +
  '`to`: teammate name | agent_runs.id | "*" for broadcast (expensive, use sparingly). ' +
  '`summary`: 5-10 word UI preview. ' +
  '`message`: plain string for DM/broadcast, OR structured object for protocol responses. ' +
  'Examples: ' +
  '{"to":"researcher","summary":"task 1","message":"start task #1"} | ' +
  '{"to":"*","summary":"halt","message":"stop work, blocking bug"} | ' +
  '{"to":"team-lead","message":{"type":"plan_approval_request","planSummary":"Draft 5 competitor-X comparison posts"}} | ' +
  '{"to":"team-lead","message":{"type":"shutdown_response","request_id":"...","approve":true}}',
```

- [ ] **Step 9: Run tests, verify all PASS**

```bash
pnpm vitest run src/tools/SendMessageTool/__tests__/SendMessageTool.test.ts
```

Expected: existing tests pass + 4 new ones pass.

- [ ] **Step 10: Type-check**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 11: Commit**

```bash
git add src/tools/SendMessageTool/
git commit -m "feat(tools): SendMessage adds plan_approval_request variant (member → lead)"
```

---

## Task 2: Schema comment update

**Files:**
- Modify: `src/lib/db/schema/team.ts`

- [ ] **Step 1: Update the messageType comment**

In `src/lib/db/schema/team.ts`, find the comment block above `messageType:` (added in Plan 4 Task 1). The current comment reads:

```
*   'plan_approval_request'      — (reserved, not yet emitted)
*   'plan_approval_response'     — lead's verdict on a plan
```

Update the first line:

```
*   'plan_approval_request'      — member's ask for lead approval before risky work
*   'plan_approval_response'     — lead's verdict on a plan
```

No SQL migration. Comment-only.

- [ ] **Step 2: Commit**

```bash
git add src/lib/db/schema/team.ts
git commit -m "docs(schema): plan_approval_request is now actually emitted"
```

---

## Task 3: Approval API route

**Files:**
- Create: `src/app/api/team/plan-approval/route.ts`
- Test: `src/app/api/team/plan-approval/__tests__/route.test.ts`

The founder UI POSTs here when approving / rejecting. The route delegates to the coordinator's SendMessage, so the audit trail shows the lead approved.

- [ ] **Step 1: Write the failing route tests**

Create `src/app/api/team/plan-approval/__tests__/route.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { teams, teamMembers, teamMessages, agentRuns, teamConversations } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { POST } from '../route';

vi.mock('@/lib/auth', () => ({
  getCurrentUserId: vi.fn(async () => 'test-user'),
}));
vi.mock('@/workers/processors/lib/wake', () => ({
  wake: vi.fn(async () => undefined),
}));

describe('POST /api/team/plan-approval', () => {
  let teamId: string;
  let coordId: string;
  let smmId: string;
  let coordRunId: string;
  let smmRunId: string;
  let convId: string;
  let requestId: string;

  beforeEach(async () => {
    teamId = crypto.randomUUID();
    coordId = crypto.randomUUID();
    smmId = crypto.randomUUID();
    coordRunId = crypto.randomUUID();
    smmRunId = crypto.randomUUID();
    convId = crypto.randomUUID();
    requestId = crypto.randomUUID();
    await db.insert(teams).values({ id: teamId, ownerId: 'test-user' });
    await db.insert(teamMembers).values([
      { id: coordId, teamId, agentType: 'coordinator', displayName: 'Coordinator', role: 'lead' },
      { id: smmId, teamId, agentType: 'social-media-manager', displayName: 'Social Media Manager', role: 'member' },
    ]);
    await db.insert(teamConversations).values({ id: convId, teamId, title: 'Test' });
    await db.insert(agentRuns).values([
      { id: coordRunId, teamId, memberId: coordId, agentDefName: 'coordinator', status: 'sleeping' },
      { id: smmRunId, teamId, memberId: smmId, agentDefName: 'social-media-manager', status: 'sleeping' },
    ]);
    await db.insert(teamMessages).values({
      id: requestId,
      teamId,
      conversationId: convId,
      fromMemberId: smmId,
      toMemberId: coordId,
      toAgentId: coordRunId,
      type: 'user_prompt',
      messageType: 'plan_approval_request',
      content: 'Draft 5 competitor-X posts',
      metadata: { planSummary: 'Draft 5 competitor-X posts', planDetails: 'confident voice' },
    });
  });

  it('approve: inserts plan_approval_response chained to the request', async () => {
    const req = new NextRequest('http://test/plan-approval', {
      method: 'POST',
      body: JSON.stringify({
        requestMessageId: requestId,
        approve: true,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.responseMessageId).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await db
      .select()
      .from(teamMessages)
      .where(eq(teamMessages.id, body.responseMessageId))
      .limit(1);
    expect(rows[0].messageType).toBe('plan_approval_response');
    expect(rows[0].repliesToId).toBe(requestId);
    expect(rows[0].toAgentId).toBe(smmRunId);
    expect(rows[0].metadata).toMatchObject({ approve: true });
    expect(rows[0].fromMemberId).toBe(coordId); // coordinator approves on founder's behalf
  });

  it('reject without feedback returns 400 (feedback required for rejection)', async () => {
    const req = new NextRequest('http://test/plan-approval', {
      method: 'POST',
      body: JSON.stringify({
        requestMessageId: requestId,
        approve: false,
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/feedback/i);
  });

  it('reject with feedback inserts response with feedback in content', async () => {
    const req = new NextRequest('http://test/plan-approval', {
      method: 'POST',
      body: JSON.stringify({
        requestMessageId: requestId,
        approve: false,
        feedback: 'Too aggressive — soften the tone.',
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    const rows = await db
      .select()
      .from(teamMessages)
      .where(eq(teamMessages.id, body.responseMessageId))
      .limit(1);
    expect(rows[0].content).toContain('soften the tone');
    expect(rows[0].metadata).toMatchObject({ approve: false });
  });

  it('wakes the requesting member', async () => {
    const { wake } = await import('@/workers/processors/lib/wake');
    const req = new NextRequest('http://test/plan-approval', {
      method: 'POST',
      body: JSON.stringify({ requestMessageId: requestId, approve: true }),
    });
    await POST(req);
    expect(wake).toHaveBeenCalledWith(smmRunId);
  });

  it('returns 409 when request is already answered (idempotent)', async () => {
    const req1 = new NextRequest('http://test/plan-approval', {
      method: 'POST',
      body: JSON.stringify({ requestMessageId: requestId, approve: true }),
    });
    expect((await POST(req1)).status).toBe(200);

    const req2 = new NextRequest('http://test/plan-approval', {
      method: 'POST',
      body: JSON.stringify({ requestMessageId: requestId, approve: false, feedback: 'no' }),
    });
    expect((await POST(req2)).status).toBe(409);
  });

  it('returns 404 when requestMessageId does not exist', async () => {
    const req = new NextRequest('http://test/plan-approval', {
      method: 'POST',
      body: JSON.stringify({ requestMessageId: 'nope', approve: true }),
    });
    expect((await POST(req)).status).toBe(404);
  });

  it('returns 400 when message is not a plan_approval_request', async () => {
    const wrongId = crypto.randomUUID();
    await db.insert(teamMessages).values({
      id: wrongId,
      teamId,
      conversationId: convId,
      fromMemberId: smmId,
      toMemberId: coordId,
      type: 'agent_text',
      messageType: 'message',
      content: 'plain',
    });
    const req = new NextRequest('http://test/plan-approval', {
      method: 'POST',
      body: JSON.stringify({ requestMessageId: wrongId, approve: true }),
    });
    expect((await POST(req)).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests, verify FAIL**

```bash
pnpm vitest run src/app/api/team/plan-approval/__tests__/route.test.ts
```

Expected: failures.

- [ ] **Step 3: Implement the route**

Create `src/app/api/team/plan-approval/route.ts`:

```typescript
// Founder UI POSTs here to approve/reject a plan_approval_request. We mint
// a plan_approval_response message attributed to the COORDINATOR (lead) so
// the audit trail says "the lead approved on the founder's behalf" — the
// founder's role here is to direct the lead's verdict, not bypass the
// agent layer.
//
// Idempotent on requestMessageId: a second POST returns 409.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { teamMessages, agentRuns, teamMembers } from '@/lib/db/schema';
import { getCurrentUserId } from '@/lib/auth';
import { wake } from '@/workers/processors/lib/wake';
import { getPubSubPublisher } from '@/lib/redis';
import { teamMessagesChannel } from '@/tools/SendMessageTool/SendMessageTool';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:team:plan-approval');

const BodySchema = z
  .object({
    requestMessageId: z.string().min(1),
    approve: z.boolean(),
    feedback: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.approve === false && (!val.feedback || val.feedback.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'feedback is required when rejecting — the requesting agent needs to know what to fix.',
        path: ['feedback'],
      });
    }
  });

export async function POST(req: NextRequest): Promise<NextResponse> {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { requestMessageId, approve, feedback } = parsed.data;

  // 1. Load + validate the request.
  const requestRows = await db
    .select()
    .from(teamMessages)
    .where(eq(teamMessages.id, requestMessageId))
    .limit(1);
  if (requestRows.length === 0) {
    return NextResponse.json({ error: 'request not found' }, { status: 404 });
  }
  const request = requestRows[0];
  if (request.messageType !== 'plan_approval_request') {
    return NextResponse.json(
      { error: 'message is not a plan_approval_request' },
      { status: 400 },
    );
  }

  // 2. Idempotency.
  const existing = await db
    .select({ id: teamMessages.id })
    .from(teamMessages)
    .where(
      and(
        eq(teamMessages.repliesToId, requestMessageId),
        eq(teamMessages.messageType, 'plan_approval_response'),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return NextResponse.json(
      { error: 'request already answered', existingResponseId: existing[0].id },
      { status: 409 },
    );
  }

  // 3. Resolve the requesting member's live agent_run for wake.
  if (!request.fromMemberId) {
    return NextResponse.json(
      { error: 'request has no fromMemberId — corrupt row' },
      { status: 500 },
    );
  }
  const requester = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.memberId, request.fromMemberId),
        inArray(agentRuns.status, ['running', 'sleeping']),
      ),
    )
    .orderBy(desc(agentRuns.lastActiveAt))
    .limit(1);
  const targetAgentId = requester[0]?.id ?? null;

  // 4. Resolve the lead's memberId for fromMemberId of the response.
  if (!request.toMemberId) {
    return NextResponse.json(
      { error: 'request has no toMemberId — corrupt row' },
      { status: 500 },
    );
  }
  const leadMemberId = request.toMemberId;

  // 5. Insert the response.
  const responseId = crypto.randomUUID();
  const createdAt = new Date();
  const content =
    feedback ?? (approve ? 'plan approved' : 'plan rejected');

  await db.insert(teamMessages).values({
    id: responseId,
    teamId: request.teamId,
    conversationId: request.conversationId,
    runId: request.runId,
    fromMemberId: leadMemberId, // lead approves on founder's behalf
    toMemberId: request.fromMemberId,
    toAgentId: targetAgentId,
    type: 'user_prompt',
    messageType: 'plan_approval_response',
    content,
    metadata: { approve },
    repliesToId: requestMessageId,
    createdAt,
  });

  // 6. Wake the requester.
  if (targetAgentId) {
    try {
      await wake(targetAgentId);
    } catch (err) {
      log.warn(
        `wake failed for member ${request.fromMemberId} (run ${targetAgentId}); response ${responseId} still durable: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // 7. Publish to SSE.
  try {
    const pub = getPubSubPublisher();
    await pub.publish(
      teamMessagesChannel(request.teamId),
      JSON.stringify({
        messageId: responseId,
        conversationId: request.conversationId,
        runId: request.runId,
        from: leadMemberId,
        to: request.fromMemberId,
        content,
        metadata: { approve },
        repliesToId: requestMessageId,
        createdAt: createdAt.toISOString(),
        type: 'user_prompt',
        messageType: 'plan_approval_response',
      }),
    );
  } catch (err) {
    log.warn(
      `Redis publish for plan_approval_response ${responseId} failed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  return NextResponse.json({ responseMessageId: responseId }, { status: 200 });
}
```

- [ ] **Step 4: Run tests, verify all PASS**

```bash
pnpm vitest run src/app/api/team/plan-approval/__tests__/route.test.ts
```

Expected: 7/7 pass.

- [ ] **Step 5: Type-check**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/app/api/team/plan-approval/
git commit -m "feat(api): POST /api/team/plan-approval — founder approves/rejects, wakes requester"
```

---

## Task 4: ApprovalCard UI component (TDD)

**Files:**
- Create: `src/app/(app)/team/_components/approval-card.tsx`
- Test: `src/app/(app)/team/_components/__tests__/approval-card.test.tsx`

Mirrors the QuestionCard pattern from Plan 4 Task 6. Two buttons (Approve / Reject), with Reject revealing a required feedback textarea.

- [ ] **Step 1: Write the failing component tests**

Create `src/app/(app)/team/_components/__tests__/approval-card.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApprovalCard } from '../approval-card';

const payload = {
  planSummary: 'Draft 5 competitor-X comparison posts',
  planDetails: 'Will use confident voice; cite specific feature gaps.',
  fromAgentName: 'Social Media Manager',
};

describe('ApprovalCard', () => {
  it('renders summary, details, and asking-agent name', () => {
    render(<ApprovalCard requestMessageId="r1" payload={payload} onSubmit={vi.fn()} />);
    expect(screen.getByText(/Draft 5 competitor-X comparison posts/)).toBeInTheDocument();
    expect(screen.getByText(/confident voice/)).toBeInTheDocument();
    expect(screen.getByText(/Social Media Manager/)).toBeInTheDocument();
  });

  it('Approve calls onSubmit with approve:true and no feedback', async () => {
    const onSubmit = vi.fn();
    render(<ApprovalCard requestMessageId="r1" payload={payload} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ approve: true }),
    );
  });

  it('Reject reveals feedback textarea, blocks submit until non-empty', async () => {
    const onSubmit = vi.fn();
    render(<ApprovalCard requestMessageId="r1" payload={payload} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /^Reject/ }));
    const textarea = screen.getByPlaceholderText(/what needs to change/i);
    expect(textarea).toBeInTheDocument();
    const sendBtn = screen.getByRole('button', { name: /Send rejection/ });
    expect(sendBtn).toBeDisabled();
    fireEvent.change(textarea, { target: { value: 'too aggressive' } });
    expect(sendBtn).toBeEnabled();
    fireEvent.click(sendBtn);
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        approve: false,
        feedback: 'too aggressive',
      }),
    );
  });

  it('disables all controls after submit (optimistic)', async () => {
    const onSubmit = vi.fn(() => new Promise<void>((r) => setTimeout(r, 100)));
    render(<ApprovalCard requestMessageId="r1" payload={payload} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Approve/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /^Reject/ })).toBeDisabled();
    });
  });

  it('shows answered state when respondedWith is provided (approved)', () => {
    render(
      <ApprovalCard
        requestMessageId="r1"
        payload={payload}
        onSubmit={vi.fn()}
        respondedWith={{ approve: true }}
      />,
    );
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.getByText(/approved/i)).toBeInTheDocument();
  });

  it('shows answered state with feedback when respondedWith is provided (rejected)', () => {
    render(
      <ApprovalCard
        requestMessageId="r1"
        payload={payload}
        onSubmit={vi.fn()}
        respondedWith={{ approve: false, feedback: 'softer please' }}
      />,
    );
    expect(screen.getByText(/rejected/i)).toBeInTheDocument();
    expect(screen.getByText(/softer please/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests, verify FAIL**

```bash
pnpm vitest run src/app/\(app\)/team/_components/__tests__/approval-card.test.tsx
```

- [ ] **Step 3: Implement the component**

Create `src/app/(app)/team/_components/approval-card.tsx`:

```tsx
'use client';

import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';

export interface ApprovalPayload {
  planSummary: string;
  planDetails?: string | null;
  /** Display name of the requesting agent — for context in the card header. */
  fromAgentName: string;
}

export interface ApprovalDecision {
  approve: boolean;
  feedback?: string;
}

interface ApprovalCardProps {
  requestMessageId: string;
  payload: ApprovalPayload;
  onSubmit: (decision: ApprovalDecision) => Promise<void> | void;
  respondedWith?: ApprovalDecision;
}

export function ApprovalCard(props: ApprovalCardProps) {
  const { payload, onSubmit, respondedWith } = props;
  const [rejectMode, setRejectMode] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(
    async (decision: ApprovalDecision) => {
      if (submitting || respondedWith) return;
      setSubmitting(true);
      try {
        await onSubmit(decision);
      } finally {
        // Stay disabled — parent re-renders with respondedWith on success.
      }
    },
    [submitting, respondedWith, onSubmit],
  );

  // ----- Responded state -----
  if (respondedWith) {
    return (
      <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
        <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
          {payload.fromAgentName} · plan
        </div>
        <div className="font-medium text-zinc-800">{payload.planSummary}</div>
        <div className="mt-2 text-zinc-700">
          {respondedWith.approve ? (
            <span className="font-medium text-green-700">✓ Approved</span>
          ) : (
            <>
              <span className="font-medium text-red-700">✗ Rejected</span>
              {respondedWith.feedback && (
                <div className="mt-1 italic text-zinc-600">
                  Feedback: {respondedWith.feedback}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  // ----- Pending state -----
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50/40 p-4 shadow-sm">
      <div className="mb-2 text-xs uppercase tracking-wide text-amber-700">
        {payload.fromAgentName} requests approval
      </div>
      <div className="mb-2 font-medium text-zinc-900">{payload.planSummary}</div>
      {payload.planDetails && (
        <div className="mb-3 whitespace-pre-wrap text-sm text-zinc-700">
          {payload.planDetails}
        </div>
      )}
      {!rejectMode ? (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => submit({ approve: true })}
            className={cn(
              'rounded bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50',
            )}
          >
            Approve
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => setRejectMode(true)}
            className={cn(
              'rounded border border-red-300 bg-white px-4 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50',
            )}
          >
            Reject
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            placeholder="What needs to change?"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            disabled={submitting}
            rows={3}
            className="w-full rounded border border-zinc-300 p-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={submitting || !feedback.trim()}
              onClick={() => submit({ approve: false, feedback: feedback.trim() })}
              className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
            >
              Send rejection
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => {
                setRejectMode(false);
                setFeedback('');
              }}
              className="rounded border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests, verify PASS**

```bash
pnpm vitest run src/app/\(app\)/team/_components/__tests__/approval-card.test.tsx
```

Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/team/_components/approval-card.tsx \
        src/app/\(app\)/team/_components/__tests__/approval-card.test.tsx
git commit -m "feat(ui): ApprovalCard for plan_approval_request — Approve / Reject(+feedback) / answered states"
```

---

## Task 5: Wire ApprovalCard into the conversation thread

**Files:**
- Modify: `src/app/(app)/team/_components/conversation-reducer.ts`
- Modify: `src/app/(app)/team/_components/conversation.tsx`

Mirror the question-stitching pattern from Plan 4 Task 7.

- [ ] **Step 1: Extend the node type**

In `src/app/(app)/team/_components/conversation-reducer.ts`, after `QuestionNode` (added in Plan 4), add:

```typescript
export interface ApprovalNode {
  kind: 'approval';
  id: string; // team_messages.id of the plan_approval_request row
  createdAt: string;
  conversationId: string;
  fromAgentName: string;
  payload: {
    planSummary: string;
    planDetails: string | null;
  };
  /** Populated when a matching plan_approval_response row exists. */
  respondedWith: { approve: boolean; feedback?: string } | null;
}
```

Update the `ConversationNode` union:

```typescript
export type ConversationNode =
  | UserNode
  | LeadNode
  | ActivityNode
  | QuestionNode
  | ApprovalNode;
```

- [ ] **Step 2: Add stitching logic**

In the row-loop, after the `'ask_user_question'` / `'user_answer'` cases (Plan 4):

```typescript
if (row.messageType === 'plan_approval_request') {
  const meta = row.metadata as { planSummary?: string; planDetails?: string | null } | null;
  if (!meta?.planSummary) continue;
  // Resolve the requesting agent's display name. The reducer should have
  // a helper for this — if not, look it up from the team_members lookup
  // map already passed into the reducer for delegation cards.
  const fromAgentName = lookupMemberDisplayName(row.fromMemberId, members) ?? 'Agent';
  nodes.push({
    kind: 'approval',
    id: row.id,
    createdAt: row.createdAt,
    conversationId: row.conversationId!,
    fromAgentName,
    payload: { planSummary: meta.planSummary, planDetails: meta.planDetails ?? null },
    respondedWith: null,
  });
  continue;
}

if (row.messageType === 'plan_approval_response') {
  // Don't render as separate node — attach to the request via repliesToId.
  continue;
}
```

After the loop, add a second pass:

```typescript
const responsesByRequestId = new Map<string, { approve: boolean; feedback?: string }>();
for (const row of rows) {
  if (row.messageType === 'plan_approval_response' && row.repliesToId) {
    const meta = row.metadata as { approve?: boolean } | null;
    if (typeof meta?.approve !== 'boolean') continue;
    responsesByRequestId.set(row.repliesToId, {
      approve: meta.approve,
      feedback: row.content ?? undefined,
    });
  }
}
for (const node of nodes) {
  if (node.kind === 'approval') {
    const resp = responsesByRequestId.get(node.id);
    if (resp) node.respondedWith = resp;
  }
}
```

(The `lookupMemberDisplayName` helper is something the reducer file likely has — grep for `displayName` in the file. If not, add a minimal one.)

- [ ] **Step 3: Render ApprovalCard in conversation.tsx**

Open `src/app/(app)/team/_components/conversation.tsx`. In the renderer switch (added in Plan 4 Task 7), add:

```tsx
import { ApprovalCard } from './approval-card';

case 'approval':
  return (
    <ApprovalCard
      key={node.id}
      requestMessageId={node.id}
      payload={{
        planSummary: node.payload.planSummary,
        planDetails: node.payload.planDetails,
        fromAgentName: node.fromAgentName,
      }}
      respondedWith={node.respondedWith ?? undefined}
      onSubmit={async (decision) => {
        const res = await fetch('/api/team/plan-approval', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestMessageId: node.id,
            ...decision,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
      }}
    />
  );
```

- [ ] **Step 4: Add reducer test**

Append to `src/app/(app)/team/_components/__tests__/conversation-reducer.test.ts`:

```typescript
describe('conversation-reducer — plan_approval stitching', () => {
  it('builds an approval node from plan_approval_request metadata', () => {
    const rows = [
      {
        id: 'r1',
        teamId: 't',
        conversationId: 'c',
        createdAt: '2026-05-04T10:00:00Z',
        type: 'user_prompt',
        messageType: 'plan_approval_request',
        content: 'Draft 5 posts',
        metadata: { planSummary: 'Draft 5 posts', planDetails: 'confident voice' },
        fromMemberId: 'smm',
        toMemberId: 'coord',
      },
    ];
    const members = [{ id: 'smm', displayName: 'Social Media Manager' }] as never;
    const nodes = buildConversationNodes(rows as never, members);
    const a = nodes.find((n) => n.kind === 'approval');
    expect(a).toBeDefined();
    expect((a as ApprovalNode).payload.planSummary).toBe('Draft 5 posts');
    expect((a as ApprovalNode).respondedWith).toBeNull();
  });

  it('attaches plan_approval_response to its request', () => {
    const rows = [
      {
        id: 'r1',
        teamId: 't',
        conversationId: 'c',
        createdAt: '2026-05-04T10:00:00Z',
        type: 'user_prompt',
        messageType: 'plan_approval_request',
        content: 'Draft 5 posts',
        metadata: { planSummary: 'Draft 5 posts', planDetails: null },
        fromMemberId: 'smm',
        toMemberId: 'coord',
      },
      {
        id: 'p1',
        teamId: 't',
        conversationId: 'c',
        createdAt: '2026-05-04T10:01:00Z',
        type: 'user_prompt',
        messageType: 'plan_approval_response',
        content: 'too aggressive',
        metadata: { approve: false },
        repliesToId: 'r1',
        fromMemberId: 'coord',
        toMemberId: 'smm',
      },
    ];
    const members = [{ id: 'smm', displayName: 'Social Media Manager' }] as never;
    const nodes = buildConversationNodes(rows as never, members);
    const a = nodes.find((n) => n.kind === 'approval') as ApprovalNode;
    expect(a.respondedWith).toEqual({ approve: false, feedback: 'too aggressive' });
  });
});
```

(Substitute `buildConversationNodes` with the actual export name.)

- [ ] **Step 5: Run all team-component tests**

```bash
pnpm vitest run src/app/\(app\)/team/
```

- [ ] **Step 6: Type-check**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/app/\(app\)/team/_components/conversation-reducer.ts \
        src/app/\(app\)/team/_components/conversation.tsx \
        src/app/\(app\)/team/_components/__tests__/conversation-reducer.test.ts
git commit -m "feat(ui): render ApprovalCard for plan_approval_request; stitch responses by repliesToId"
```

---

## Task 6: Teach social-media-manager + coordinator the new pattern

**Files:**
- Modify: `src/tools/AgentTool/agents/social-media-manager/AGENT.md`
- Modify: `src/tools/AgentTool/agents/social-media-manager/references/patterns-and-examples.md`
- Modify: `src/tools/AgentTool/agents/coordinator/AGENT.md`

- [ ] **Step 1: Add a pattern to social-media-manager's patterns-and-examples**

Append to `src/tools/AgentTool/agents/social-media-manager/references/patterns-and-examples.md`:

```markdown
### Pattern: ask-then-batch (gate risky drafting on lead approval)

You're about to run `process_posts_batch` or `process_replies_batch` on
content that's unusually risky — naming a competitor by name, taking a
strong stance on industry drama, or anything the founder would want to
greenlight before it hits /briefing. Send a plan_approval_request to the
coordinator and wait.

You: SendMessage({
  to: 'Coordinator',
  message: {
    type: 'plan_approval_request',
    planSummary: 'Draft 5 posts naming competitor X by name in this week\\'s comparison angle',
    planDetails: 'Confident voice. Will cite 3 specific feature gaps from public docs. Risk: reads as petty if voice slips.'
  }
})

(turn ends; coordinator surfaces to founder; founder decides)

[next turn — response arrives in your inbox as a normal user message]

If approved: process_posts_batch as planned.
If rejected with feedback: incorporate the feedback (e.g. "soften the tone")
in your spawn prompt to the batch tool — pass it through the `voice` arg
or a `voiceOverride` block.

When NOT to ask:
- Routine drafting (the default — no approval needed for everyday slot fills).
- Reply drafts — those go through validating-draft + REVISE, that's enough.
- Posts already approved in a prior turn (don't double-ask).

The bar: if the founder would be unhappy seeing it in /briefing without
having been asked first, ask first.
```

- [ ] **Step 2: Add a note to coordinator's AGENT.md**

Open `src/tools/AgentTool/agents/coordinator/AGENT.md`. Find the "Hard rules" section. Add:

```markdown
- **Plan approvals route through the founder UI.** When social-media-manager
  sends you a `plan_approval_request` SendMessage, the request renders as
  an ApprovalCard in the founder's conversation thread. The founder clicks
  Approve / Reject(+feedback); the API mints a `plan_approval_response`
  on your behalf. You do NOT need to send the response yourself — the API
  does it. Your job: be aware that the request landed in your mailbox, and
  trust the founder + UI to resolve it.
```

(This is a behavioral hint; the SendMessage `plan_approval_response` dispatcher is still lead-only via runtime check, which prevents accidental double-responses if the coordinator tries to respond directly.)

- [ ] **Step 3: Run loader tests**

```bash
pnpm vitest run src/tools/AgentTool/agents/coordinator/ src/tools/AgentTool/agents/social-media-manager/
```

- [ ] **Step 4: Commit**

```bash
git add src/tools/AgentTool/agents/social-media-manager/ \
        src/tools/AgentTool/agents/coordinator/AGENT.md
git commit -m "feat(agents): teach social-media-manager + coordinator the plan_approval_request flow"
```

---

## Task 7: Real-browser smoke test

**Files:**
- Create: `e2e/plan-approval-smoke.spec.ts`
- Modify (extend): `src/app/api/_test/seed-question/route.ts` — add a sibling endpoint for seeding plan_approval_requests, OR create a new file.

Easier path: a separate dev-only seed endpoint. The smoke seeds a request, asserts the ApprovalCard renders, clicks Approve, asserts the response row appears.

- [ ] **Step 1: Add the dev-only seed endpoint**

Create `src/app/api/_test/seed-plan-approval/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sendMessageTool } from '@/tools/SendMessageTool/SendMessageTool';
import { getCurrentUserId } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamMembers, teamConversations, agentRuns } from '@/lib/db/schema';
import { and, desc, eq } from 'drizzle-orm';

const BodySchema = z.object({
  planSummary: z.string(),
  planDetails: z.string().optional(),
});

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }

  const [team] = await db.select().from(teams).where(eq(teams.ownerId, userId)).limit(1);
  if (!team) return NextResponse.json({ error: 'no team' }, { status: 404 });

  const [smm] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.agentType, 'social-media-manager')))
    .limit(1);
  const [coord] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.agentType, 'coordinator')))
    .limit(1);
  if (!smm || !coord) return NextResponse.json({ error: 'team not provisioned' }, { status: 404 });

  const [conv] = await db
    .select()
    .from(teamConversations)
    .where(eq(teamConversations.teamId, team.id))
    .orderBy(desc(teamConversations.createdAt))
    .limit(1);
  if (!conv) return NextResponse.json({ error: 'no conversation' }, { status: 404 });

  // Ensure a coordinator agent_run exists (target for the approval request).
  let [coordRun] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.memberId, coord.id), eq(agentRuns.status, 'sleeping')))
    .limit(1);
  if (!coordRun) {
    const id = crypto.randomUUID();
    await db.insert(agentRuns).values({
      id,
      teamId: team.id,
      memberId: coord.id,
      agentDefName: 'coordinator',
      status: 'sleeping',
    });
    [coordRun] = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
  }

  // Ensure social-media-manager agent_run exists (sender of the request).
  let [smmRun] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.memberId, smm.id), eq(agentRuns.status, 'running')))
    .limit(1);
  if (!smmRun) {
    const id = crypto.randomUUID();
    await db.insert(agentRuns).values({
      id,
      teamId: team.id,
      memberId: smm.id,
      agentDefName: 'social-media-manager',
      status: 'running',
    });
    [smmRun] = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
  }

  const ctx = {
    get<T>(key: string): T {
      switch (key) {
        case 'teamId': return team.id as unknown as T;
        case 'currentMemberId': return smm.id as unknown as T;
        case 'runId': return smmRun.id as unknown as T;
        case 'conversationId': return conv.id as unknown as T;
        case 'callerRole': return 'member' as unknown as T;
        default: throw new Error(`unknown ctx key: ${key}`);
      }
    },
  };

  const result = await sendMessageTool.execute(
    {
      to: coord.displayName,
      message: {
        type: 'plan_approval_request',
        planSummary: parsed.data.planSummary,
        planDetails: parsed.data.planDetails,
      },
    },
    ctx as never,
  );

  return NextResponse.json({
    requestMessageId: result.messageId,
    conversationId: conv.id,
  });
}
```

- [ ] **Step 2: Write the smoke**

Create `e2e/plan-approval-smoke.spec.ts`:

```typescript
import { test, expect, chromium } from '@playwright/test';

test('plan_approval_request: card renders, founder approves, response chains back', async () => {
  test.skip(
    !process.env.SHIPFLARE_TEST_SEED_ENABLED,
    'set SHIPFLARE_TEST_SEED_ENABLED=1 to run',
  );

  const browser = await chromium.connectOverCDP(
    process.env.CHROMIUM_CDP_URL ?? 'http://localhost:9222',
  );
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();

  // 1. Seed a plan_approval_request
  const seedRes = await page.request.post(
    'http://localhost:3000/api/_test/seed-plan-approval',
    {
      data: {
        planSummary: 'Smoke: draft 5 competitor-X posts',
        planDetails: 'Confident voice; cite 3 feature gaps.',
      },
    },
  );
  expect(seedRes.ok()).toBeTruthy();
  const { requestMessageId, conversationId } = await seedRes.json();

  // 2. Navigate to the conversation; verify ApprovalCard rendered
  await page.goto(`http://localhost:3000/team?conversation=${conversationId}`);
  await expect(page.getByText('Smoke: draft 5 competitor-X posts')).toBeVisible({
    timeout: 10_000,
  });
  const approveBtn = page.getByRole('button', { name: /Approve/ });
  await expect(approveBtn).toBeVisible();

  // 3. Approve
  await approveBtn.click();

  // 4. Verify the responded state
  await expect(page.getByText(/Approved/i)).toBeVisible({ timeout: 5_000 });

  // 5. Poll the API to confirm a plan_approval_response row was minted
  let responseSeen = false;
  for (let i = 0; i < 10; i++) {
    const res = await page.request.get(
      `http://localhost:3000/api/team/conversations/${conversationId}/messages?after=${requestMessageId}`,
    );
    if (res.ok()) {
      const body = await res.json();
      if (body.messages?.some(
        (m: { messageType: string; repliesToId: string; metadata?: { approve?: boolean } }) =>
          m.messageType === 'plan_approval_response' &&
          m.repliesToId === requestMessageId &&
          m.metadata?.approve === true,
      )) {
        responseSeen = true;
        break;
      }
    }
    await page.waitForTimeout(500);
  }
  expect(responseSeen).toBe(true);

  // 6. Repeat the smoke for rejection — different conversation to avoid idempotency clash
  const seedRes2 = await page.request.post(
    'http://localhost:3000/api/_test/seed-plan-approval',
    {
      data: {
        planSummary: 'Smoke: rejection test',
        planDetails: 'will be rejected',
      },
    },
  );
  const { requestMessageId: req2, conversationId: conv2 } = await seedRes2.json();
  await page.goto(`http://localhost:3000/team?conversation=${conv2}`);
  await page.getByRole('button', { name: /^Reject/ }).click();
  const textarea = page.getByPlaceholderText(/what needs to change/i);
  await textarea.fill('soften the tone');
  await page.getByRole('button', { name: /Send rejection/ }).click();
  await expect(page.getByText(/Rejected/i)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/soften the tone/)).toBeVisible();

  await browser.close();
});
```

- [ ] **Step 3: Run the smoke locally**

```bash
# Terminal 1
SHIPFLARE_TEST_SEED_ENABLED=1 pnpm dev

# Terminal 2 (Chrome with CDP, may already be running from Plan 4)
open -na "Google Chrome" --args --remote-debugging-port=9222

# Terminal 3
pnpm playwright test e2e/plan-approval-smoke.spec.ts --reporter=list
```

Expected: PASS within 60s.

- [ ] **Step 4: Commit**

```bash
git add e2e/plan-approval-smoke.spec.ts \
        src/app/api/_test/seed-plan-approval/route.ts
git commit -m "test(e2e): real-browser smoke for plan_approval_request — Approve and Reject(+feedback)"
```

---

## Task 8: CLAUDE.md note + final verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add note**

In `CLAUDE.md`, find the section added in Plan 4 about AskUserQuestion. Add a sibling section below:

```markdown
## Plan approval (member → lead → founder)

Members can submit a plan via SendMessage with
`message: { type: 'plan_approval_request', planSummary, planDetails? }`. The
request appears as an ApprovalCard in the founder's conversation thread;
Approve / Reject(+feedback) routes through `POST /api/team/plan-approval`,
which mints a `plan_approval_response` attributed to the lead and `wake()`s
the requesting member. The member's next user-role message is the verdict.

- `plan_approval_request` is **member-only** (lead validates).
- `plan_approval_response` is **lead-only** (existing constraint).
- The founder UI mints the response on the lead's behalf — agents do NOT
  send `plan_approval_response` directly.

Tool source: `src/tools/SendMessageTool/SendMessageTool.ts`
(`dispatchPlanApprovalRequest`). UI: `src/app/(app)/team/_components/approval-card.tsx`.
API: `POST /api/team/plan-approval`.
```

- [ ] **Step 2: Greppable invariants**

```bash
# Variant present in tool
grep -c "plan_approval_request" src/tools/SendMessageTool/SendMessageTool.ts
# Expected: ≥3 (variant decl, dispatch, validateInput)

# Member-only check in place
grep -A1 "plan_approval_request is member-only" src/tools/SendMessageTool/SendMessageTool.ts
# Expected: 1 hit

# API route exists
ls src/app/api/team/plan-approval/route.ts
# Expected: file exists

# UI component exists
ls src/app/\(app\)/team/_components/approval-card.tsx
# Expected: file exists

# Both agents updated
grep -l "plan_approval_request" src/tools/AgentTool/agents/*/AGENT.md src/tools/AgentTool/agents/*/references/*.md
# Expected: at least 2 hits across the two agents
```

- [ ] **Step 3: Type-check + tests**

```bash
pnpm tsc --noEmit
pnpm vitest run --reporter=basic
```

- [ ] **Step 4: Push**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE): document plan_approval_request flow + member/lead role constraints"
git push -u origin HEAD
```

---

## Self-Review

**Spec coverage:**
- SendMessage variant added with tests → Task 1 ✓
- Schema comment refreshed → Task 2 ✓
- Approval API route + idempotency + feedback-required-on-reject → Task 3 ✓
- ApprovalCard component (Approve / Reject+feedback / answered states) → Task 4 ✓
- Reducer + renderer wired → Task 5 ✓
- AGENT.md updates for both agents → Task 6 ✓
- Real-browser smoke (approve + reject paths) → Task 7 ✓
- CLAUDE.md note → Task 8 ✓

**Placeholder scan:** No "TBD" / "implement later". Every code step shows the actual code.

**Type consistency:**
- `StructuredMessage` discriminated union (Task 1) ↔ `BodySchema` in route (Task 3) ↔ `ApprovalPayload` UI type (Task 4) ↔ `ApprovalNode` reducer type (Task 5) all carry `{planSummary, planDetails?}`.
- `repliesToId` chains `plan_approval_request` → `plan_approval_response` end-to-end (DB write in dispatcher, route insertion, reducer stitching, UI lookup).
- `metadata.approve: boolean` is the canonical truth for approval state — same shape in tool dispatcher (Task 1), API route (Task 3), reducer (Task 5).

---

## Tradeoffs / risks

- **Founder is the actual approver, but the audit trail says "lead approved".** This is intentional — the lead is the agent layer's authority on plan verdicts, and the founder UI is the lead's interface. If we ever need to audit "who actually clicked", the API route logs `userId` from `getCurrentUserId()`; that maps to the human via `users.email`.
- **No timeout on pending requests.** A founder who never answers leaves the member sleeping indefinitely. Acceptable v1 — `stale-sweeper` handles dead runs. Could add a `pendingSince` filter in the founder's task panel later to surface old asks.
- **No "Other" path on approval.** Unlike AskUserQuestion's "Other" text input, approval is binary (Approve / Reject) — feedback-on-reject is the closest analogue. Not adding a third "Modify and approve" path; that would split the verdict semantics.
- **The validateInput member-only check uses `getCallerRole(ctx)`.** If a caller forgets to inject `callerRole`, the check fails closed (returns 403). This is the right default but means tests must remember to inject the role — the test helpers in Task 1's tests do this; document for new test authors via comment in `makeMockToolContext`.
- **Two agents only post-collapse → low real-world demand for this primitive.** The plan ships infra that becomes more valuable when Tier-2 agents (PMM, SEO) join — those agents will WRITE more risky plans and benefit from gating. Don't gold-plate the social-media-manager use case; it's a small percentage of its work.
- **The card and the question card share a lot of code shape.** Could extract a `<RequestCard>` parent. Don't — DRY-via-extraction here would require both components to live behind a config-shaped abstraction that doesn't carry its weight at 2 instances. Revisit when a third request-shaped primitive lands.
