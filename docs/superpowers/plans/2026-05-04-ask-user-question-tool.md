# AskUserQuestion Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Claude Code engine's `AskUserQuestion` tool to ShipFlare so any agent (coordinator, social-media-manager) can pose a structured 2–4-option multiple-choice question to the founder, wait for an answer, and continue. Closes the highest-value Tier-1 gap from `engine/` vs current architecture.

**Architecture:**
1. **New tool `AskUserQuestion`** — Zod-validated input (`questions[].options[]`), inserts a `team_messages` row with `messageType='ask_user_question'` carrying the structured question payload in `metadata`, returns synchronously with `{ asked: true, questionMessageId }`. The agent ends its turn (or calls `Sleep`) after asking.
2. **Founder answer = normal `user_prompt`** — POST `/api/team/conversations/[conversationId]/answer` inserts a `team_messages` row with `messageType='user_answer'`, `repliesToId` chained to the question, and `wake()`s the asking agent. From the agent's POV the answer arrives as the next user-role message in its mailbox drain — no new runtime state machine, no deferred tool-result plumbing.
3. **UI: `QuestionCard`** — renders inline in the conversation thread, shows the question + 2–4 option buttons + an always-present "Other" text input (matching engine UX). Answered state collapses to a pill showing `{question} → {answer}`.
4. **Both shipped agents get the tool** — `coordinator` (primary use: clarify founder intent before taking action) and `social-media-manager` (e.g. voice-direction tie-breaks).
5. **Engine-aligned schema, ShipFlare transport** — input shape is field-for-field a port of `engine/tools/AskUserQuestionTool/AskUserQuestionTool.tsx` (questions[1..4], options[2..4], multiSelect, optional preview omitted in v1). Transport is our DB+Redis+wake stack, not engine's blocking ink dialog.

**Tech Stack:**
- TypeScript / Zod (tool schema)
- Drizzle (no schema change — `messageType` is a free-text column; new values are just new strings)
- Next.js API route + React Server Components (founder UI)
- Redis pub/sub for live-delivery of the question card to open `/team` tabs
- Vitest unit tests, Playwright real-browser smoke

**Depends on (must merge first):**
- `2026-05-03-merge-judging-and-share-slop-rules.md` (Plan 1)
- `2026-05-04-pipeline-to-tools.md` (Plan 2)
- `2026-05-04-collapse-to-social-media-manager.md` (Plan 3)

After those land, the agent roster is `coordinator` + `social-media-manager` only. This plan adds `AskUserQuestion` to both.

---

## File map

**Created**
- `src/tools/AskUserQuestionTool/AskUserQuestionTool.ts`
- `src/tools/AskUserQuestionTool/__tests__/AskUserQuestionTool.test.ts`
- `src/app/api/team/conversations/[conversationId]/answer/route.ts`
- `src/app/api/team/conversations/[conversationId]/answer/__tests__/route.test.ts`
- `src/app/(app)/team/_components/question-card.tsx`
- `src/app/(app)/team/_components/__tests__/question-card.test.tsx`
- `e2e/ask-user-question-smoke.spec.ts`

**Modified**
- `src/tools/registry-team.ts` (register `askUserQuestionTool`)
- `src/tools/AgentTool/agents/coordinator/AGENT.md` (add `AskUserQuestion` to tool list + 1 reference example)
- `src/tools/AgentTool/agents/coordinator/references/decision-examples.md` (one new example: clarifying ambiguous founder intent)
- `src/tools/AgentTool/agents/social-media-manager/AGENT.md` (add `AskUserQuestion` to tool list + reference pointer)
- `src/tools/AgentTool/agents/social-media-manager/references/patterns-and-examples.md` (one new pattern: voice tie-break)
- `src/app/(app)/team/_components/conversation-reducer.ts` (handle `messageType='ask_user_question'` and `'user_answer'`)
- `src/app/(app)/team/_components/conversation.tsx` (render `<QuestionCard>` for question rows, render answer pill for answer rows)
- `src/lib/db/schema/team.ts` (one comment-only edit listing the two new `messageType` values for grep-ability)
- `src/workers/processors/lib/mailbox-drain.ts` (NO CODE CHANGE — verify `user_answer` rows drain correctly via existing `to_agent_id` index; document with a test)
- `CLAUDE.md` (one-line entry under "Skill Primitive" section noting `AskUserQuestion` exists)

**Deleted**
- (none)

---

## Task 1: Document new messageType values + verify mailbox drain compatibility

**Files:**
- Modify: `src/lib/db/schema/team.ts:171`
- Test: `src/workers/processors/lib/__tests__/mailbox-drain-user-answer.test.ts` (new — verifies existing drain works for the new shape)

The `messageType` column is `text` (no enum, no CHECK constraint). New values are just new strings. The job here is documentation + a regression-guard test that proves the existing mailbox-drain partial index `idx_team_messages_to_undelivered` picks up rows with `messageType='user_answer'` when `to_agent_id` is set — because that's the route the founder's answer takes to the asking agent.

- [ ] **Step 1: Read the existing schema comment**

```bash
sed -n '165,180p' src/lib/db/schema/team.ts
```

Currently line 171 says:
```
// 'user_prompt' | 'agent_text' | 'tool_call' | 'tool_result' | 'completion' | 'error' | 'thinking'
```

That's the LLM-flow `type` column. The `messageType` column (line 183) has no inline enumeration. Add one.

- [ ] **Step 2: Edit the schema comment**

Open `src/lib/db/schema/team.ts`. Find the `messageType` column declaration (currently around line 178–183). Add a comment above it listing all valid values:

```typescript
    /**
     * Agent Teams protocol type. Orthogonal to existing `type` (which is
     * the LLM-flow kind: user_prompt / agent_text / tool_call / etc.).
     * `task_notification` rows have type='user_prompt' AND
     * messageType='task_notification'.
     *
     * Valid values:
     *   'message'                    — plain DM / agent text
     *   'broadcast'                  — fan-out from to:'*' (Phase B)
     *   'task_notification'          — system-synthesized <task-notification>
     *   'shutdown_request'           — graceful kill ask (lead → member)
     *   'shutdown_response'          — member's reply to shutdown_request
     *   'plan_approval_request'      — (reserved, not yet emitted)
     *   'plan_approval_response'     — lead's verdict on a plan
     *   'ask_user_question'          — agent → founder structured question
     *   'user_answer'                — founder → agent reply to ask_user_question
     */
    messageType: text('message_type').notNull().default('message'),
```

No SQL migration is needed — this is a comment-only change. Drizzle won't generate a migration.

- [ ] **Step 3: Write the failing drain regression test**

Create `src/workers/processors/lib/__tests__/mailbox-drain-user-answer.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { teamMessages, agentRuns, teams, teamMembers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { drainMailbox } from '../mailbox-drain';

describe('mailbox-drain — user_answer messages', () => {
  let teamId: string;
  let memberId: string;
  let agentRunId: string;

  beforeEach(async () => {
    teamId = crypto.randomUUID();
    memberId = crypto.randomUUID();
    agentRunId = crypto.randomUUID();
    await db.insert(teams).values({ id: teamId, ownerId: 'test-user' });
    await db.insert(teamMembers).values({
      id: memberId,
      teamId,
      agentType: 'coordinator',
      displayName: 'Coordinator',
      role: 'lead',
    });
    await db.insert(agentRuns).values({
      id: agentRunId,
      teamId,
      memberId,
      agentDefName: 'coordinator',
      status: 'sleeping',
    });
  });

  afterAll(async () => {
    // Cleanup is per-suite; foreign-key cascade handles rows
    await db.delete(teams).where(eq(teams.id, teamId));
  });

  it('drains a user_answer row addressed to the asking agent', async () => {
    const questionId = crypto.randomUUID();
    const answerId = crypto.randomUUID();

    // Original question (sent BY the agent, not its mailbox concern here)
    await db.insert(teamMessages).values({
      id: questionId,
      teamId,
      fromMemberId: memberId,
      toMemberId: null, // null = founder
      type: 'tool_call',
      messageType: 'ask_user_question',
      content: 'Ship now or wait?',
      metadata: { questions: [{ question: 'Ship now or wait?', options: [{ label: 'Ship', description: '' }, { label: 'Wait', description: '' }] }] },
    });

    // Founder's answer — this is what the drain picks up
    await db.insert(teamMessages).values({
      id: answerId,
      teamId,
      fromMemberId: null, // null = founder
      toAgentId: agentRunId,
      type: 'user_prompt',
      messageType: 'user_answer',
      content: 'Ship',
      repliesToId: questionId,
    });

    const drained = await drainMailbox(agentRunId);

    expect(drained.length).toBe(1);
    expect(drained[0].id).toBe(answerId);
    expect(drained[0].messageType).toBe('user_answer');
    expect(drained[0].repliesToId).toBe(questionId);

    // Drain marks delivered_at — re-draining returns nothing
    const drainedAgain = await drainMailbox(agentRunId);
    expect(drainedAgain.length).toBe(0);
  });
});
```

- [ ] **Step 4: Run the test**

```bash
pnpm vitest run src/workers/processors/lib/__tests__/mailbox-drain-user-answer.test.ts
```

Expected: PASS. The drain is generic over `messageType` — it reads `to_agent_id` + `delivered_at IS NULL`, so any new messageType automatically works. If the test FAILS (e.g. `drainMailbox` filters by messageType), that's a real bug and Task 4 needs to fix the drain.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/schema/team.ts \
        src/workers/processors/lib/__tests__/mailbox-drain-user-answer.test.ts
git commit -m "docs(schema): enumerate team_messages.message_type values; verify drain handles user_answer"
```

---

## Task 2: AskUserQuestion tool (TDD)

**Files:**
- Create: `src/tools/AskUserQuestionTool/AskUserQuestionTool.ts`
- Test: `src/tools/AskUserQuestionTool/__tests__/AskUserQuestionTool.test.ts`

- [ ] **Step 1: Write the failing tool tests**

Create `src/tools/AskUserQuestionTool/__tests__/AskUserQuestionTool.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '@/lib/db';
import { teamMessages, teams, teamMembers, agentRuns, teamConversations } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import {
  askUserQuestionTool,
  ASK_USER_QUESTION_TOOL_NAME,
  AskUserQuestionInputSchema,
} from '../AskUserQuestionTool';

describe('AskUserQuestion tool — schema', () => {
  it('rejects fewer than 1 question', () => {
    const r = AskUserQuestionInputSchema.safeParse({ questions: [] });
    expect(r.success).toBe(false);
  });

  it('rejects more than 4 questions', () => {
    const r = AskUserQuestionInputSchema.safeParse({
      questions: Array.from({ length: 5 }, (_, i) => ({
        question: `Q${i}?`,
        header: `H${i}`,
        options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: 'b' },
        ],
      })),
    });
    expect(r.success).toBe(false);
  });

  it('rejects fewer than 2 options', () => {
    const r = AskUserQuestionInputSchema.safeParse({
      questions: [
        { question: 'q?', header: 'H', options: [{ label: 'A', description: 'a' }] },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects more than 4 options', () => {
    const r = AskUserQuestionInputSchema.safeParse({
      questions: [
        {
          question: 'q?',
          header: 'H',
          options: Array.from({ length: 5 }, (_, i) => ({ label: `O${i}`, description: '' })),
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('accepts a valid 1-question payload', () => {
    const r = AskUserQuestionInputSchema.safeParse({
      questions: [
        {
          question: 'Ship now or wait?',
          header: 'Ship timing',
          options: [
            { label: 'Ship', description: 'Push to prod immediately' },
            { label: 'Wait', description: 'Hold until tomorrow' },
          ],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects duplicate question text', () => {
    const r = AskUserQuestionInputSchema.safeParse({
      questions: [
        { question: 'Same?', header: 'H1', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
        { question: 'Same?', header: 'H2', options: [{ label: 'C', description: '' }, { label: 'D', description: '' }] },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects duplicate option label within a single question', () => {
    const r = AskUserQuestionInputSchema.safeParse({
      questions: [
        {
          question: 'q?',
          header: 'H',
          options: [
            { label: 'A', description: 'first' },
            { label: 'A', description: 'second' },
          ],
        },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe('AskUserQuestion tool — execute', () => {
  let teamId: string;
  let memberId: string;
  let conversationId: string;
  let agentRunId: string;

  beforeEach(async () => {
    teamId = crypto.randomUUID();
    memberId = crypto.randomUUID();
    conversationId = crypto.randomUUID();
    agentRunId = crypto.randomUUID();
    await db.insert(teams).values({ id: teamId, ownerId: 'test-user' });
    await db.insert(teamMembers).values({
      id: memberId,
      teamId,
      agentType: 'coordinator',
      displayName: 'Coordinator',
      role: 'lead',
    });
    await db.insert(teamConversations).values({
      id: conversationId,
      teamId,
      title: 'Test',
    });
    await db.insert(agentRuns).values({
      id: agentRunId,
      teamId,
      memberId,
      agentDefName: 'coordinator',
      status: 'running',
    });
  });

  it('inserts a team_messages row with messageType=ask_user_question', async () => {
    const ctx = makeMockToolContext({ teamId, currentMemberId: memberId, runId: agentRunId, conversationId });
    const result = await askUserQuestionTool.execute(
      {
        questions: [
          {
            question: 'Ship?',
            header: 'Timing',
            options: [
              { label: 'Yes', description: 'now' },
              { label: 'No', description: 'wait' },
            ],
          },
        ],
      },
      ctx,
    );

    expect(result.asked).toBe(true);
    expect(result.questionMessageId).toMatch(/^[0-9a-f-]{36}$/);

    const row = await db
      .select()
      .from(teamMessages)
      .where(eq(teamMessages.id, result.questionMessageId))
      .limit(1);
    expect(row.length).toBe(1);
    expect(row[0].messageType).toBe('ask_user_question');
    expect(row[0].type).toBe('agent_text');
    expect(row[0].fromMemberId).toBe(memberId);
    expect(row[0].toMemberId).toBeNull();
    expect(row[0].conversationId).toBe(conversationId);
    expect(row[0].metadata).toMatchObject({
      questions: [
        {
          question: 'Ship?',
          header: 'Timing',
          options: [
            { label: 'Yes', description: 'now' },
            { label: 'No', description: 'wait' },
          ],
          multiSelect: false,
        },
      ],
    });
    // Human-readable preview content for log views
    expect(row[0].content).toContain('Ship?');
  });

  it('returns immediately (does not await answer)', async () => {
    const ctx = makeMockToolContext({ teamId, currentMemberId: memberId, runId: agentRunId, conversationId });
    const start = Date.now();
    await askUserQuestionTool.execute(
      {
        questions: [
          {
            question: 'q?',
            header: 'H',
            options: [
              { label: 'A', description: '' },
              { label: 'B', description: '' },
            ],
          },
        ],
      },
      ctx,
    );
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('publishes to Redis for live SSE delivery', async () => {
    const publishSpy = vi.spyOn(await import('@/lib/redis'), 'getPubSubPublisher');
    const ctx = makeMockToolContext({ teamId, currentMemberId: memberId, runId: agentRunId, conversationId });
    await askUserQuestionTool.execute(
      {
        questions: [
          {
            question: 'q?',
            header: 'H',
            options: [
              { label: 'A', description: '' },
              { label: 'B', description: '' },
            ],
          },
        ],
      },
      ctx,
    );
    expect(publishSpy).toHaveBeenCalled();
  });

  it('throws when no conversationId in ctx (questions need a thread to attach to)', async () => {
    const ctx = makeMockToolContext({ teamId, currentMemberId: memberId, runId: agentRunId, conversationId: null });
    await expect(
      askUserQuestionTool.execute(
        {
          questions: [
            { question: 'q?', header: 'H', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/conversation/i);
  });
});

// Helper — builds a minimal ToolContext implementation for tests.
// Mirrors src/tools/SendMessageTool/__tests__/ helpers; if a shared test
// helper exists in src/tools/__tests__/, prefer it.
function makeMockToolContext(values: {
  teamId: string;
  currentMemberId: string | null;
  runId: string | null;
  conversationId: string | null;
}) {
  const map = new Map<string, unknown>();
  if (values.teamId) map.set('teamId', values.teamId);
  if (values.currentMemberId) map.set('currentMemberId', values.currentMemberId);
  if (values.runId) map.set('runId', values.runId);
  if (values.conversationId) map.set('conversationId', values.conversationId);
  return {
    get<T>(k: string): T {
      if (!map.has(k)) throw new Error(`ctx key not set: ${k}`);
      return map.get(k) as T;
    },
  } as unknown as Parameters<typeof askUserQuestionTool.execute>[1];
}
```

- [ ] **Step 2: Run tests, verify all FAIL**

```bash
pnpm vitest run src/tools/AskUserQuestionTool/__tests__/AskUserQuestionTool.test.ts
```

Expected: All tests fail with `Cannot find module '../AskUserQuestionTool'`.

- [ ] **Step 3: Implement the tool**

Create `src/tools/AskUserQuestionTool/AskUserQuestionTool.ts`:

```typescript
// Port of engine/tools/AskUserQuestionTool/AskUserQuestionTool.tsx adapted to
// ShipFlare's transport. Engine's tool blocks via shouldDefer:true and a
// terminal ink dialog; we instead INSERT a team_messages row with
// messageType='ask_user_question' and return synchronously. The agent must
// end its turn (or call Sleep) after asking — its next user-role message
// will be the founder's answer (messageType='user_answer', repliesToId
// chained). See plan 2026-05-04-ask-user-question-tool.md for the full
// rationale.

import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolContext, ToolDefinition } from '@/core/types';
import { createLogger } from '@/lib/logger';
import { db as defaultDb, type Database } from '@/lib/db';
import { teamMessages } from '@/lib/db/schema';
import { getPubSubPublisher } from '@/lib/redis';
import { teamMessagesChannel } from '@/tools/SendMessageTool/SendMessageTool';

const log = createLogger('tools:AskUserQuestion');

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

/** Engine constraint: chip width 12 chars max. We keep the same cap for UI parity. */
export const ASK_USER_QUESTION_HEADER_MAX = 12;

const QuestionOption = z.object({
  label: z
    .string()
    .min(1)
    .max(40)
    .describe(
      'Display text the founder sees and selects. Concise (1-5 words). Mutually exclusive ' +
        'across options unless multiSelect is true.',
    ),
  description: z
    .string()
    .max(200)
    .describe(
      'One-line context: what this option means or what will happen if chosen.',
    ),
});

const Question = z.object({
  question: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'The complete question. End with "?". Phrase as multi-select if multiSelect=true.',
    ),
  header: z
    .string()
    .min(1)
    .max(ASK_USER_QUESTION_HEADER_MAX)
    .describe(
      `Short label (max ${ASK_USER_QUESTION_HEADER_MAX} chars) shown as a chip in the UI. ` +
        'Examples: "Ship timing", "Voice", "Channel".',
    ),
  options: z.array(QuestionOption).min(2).max(4),
  multiSelect: z
    .boolean()
    .default(false)
    .describe('Allow multiple options to be selected. Use when choices are not exclusive.'),
});

export const AskUserQuestionInputSchema = z
  .object({
    questions: z.array(Question).min(1).max(4),
  })
  .superRefine((val, ctx) => {
    const questionTexts = val.questions.map((q) => q.question);
    if (questionTexts.length !== new Set(questionTexts).size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Question texts must be unique within a single AskUserQuestion call.',
      });
    }
    for (const q of val.questions) {
      const labels = q.options.map((o) => o.label);
      if (labels.length !== new Set(labels).size) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Option labels must be unique within question "${q.question}".`,
        });
      }
    }
  });

export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>;

export interface AskUserQuestionResult {
  asked: true;
  questionMessageId: string;
}

function readCtx(ctx: ToolContext): {
  teamId: string;
  currentMemberId: string | null;
  runId: string | null;
  conversationId: string | null;
  db: Database;
} {
  const teamId = ctx.get<string>('teamId');
  const tryGet = <T>(k: string): T | null => {
    try {
      return ctx.get<T>(k);
    } catch {
      return null;
    }
  };
  return {
    teamId,
    currentMemberId: tryGet<string>('currentMemberId'),
    runId: tryGet<string>('runId'),
    conversationId: tryGet<string>('conversationId'),
    db: tryGet<Database>('db') ?? defaultDb,
  };
}

function formatPreviewContent(input: AskUserQuestionInput): string {
  // Human-readable single-line summary, used in DB `content` for log/grep
  // surfaces. UI renders the structured payload from `metadata.questions`.
  return input.questions
    .map((q) => {
      const opts = q.options.map((o) => o.label).join(' / ');
      return `${q.question} (${opts})`;
    })
    .join(' | ');
}

export const askUserQuestionTool: ToolDefinition<
  AskUserQuestionInput,
  AskUserQuestionResult
> = buildTool({
  name: ASK_USER_QUESTION_TOOL_NAME,
  description:
    'Ask the founder one or more multiple-choice questions. Use when you need a decision, ' +
    'a clarification, or a preference before continuing. After calling, end your turn — ' +
    'the founder\'s answer arrives as your next user message (messageType=user_answer). ' +
    'Limits: 1-4 questions, 2-4 options per question. The UI always offers an "Other" ' +
    'free-text input in addition to your provided options.',
  inputSchema: AskUserQuestionInputSchema,
  isConcurrencySafe: true,
  isReadOnly: false,
  async execute(input, ctx): Promise<AskUserQuestionResult> {
    const { teamId, currentMemberId, runId, conversationId, db } = readCtx(ctx);

    if (!conversationId) {
      throw new Error(
        'AskUserQuestion: no conversationId in ToolContext. Questions must attach to a ' +
          'specific conversation thread so the founder sees them in /team. ' +
          'If you reached this from a non-team-run code path, that path needs a ' +
          'conversationId injected before calling this tool.',
      );
    }

    const messageId = crypto.randomUUID();
    const createdAt = new Date();
    const previewContent = formatPreviewContent(input);

    // Normalize for storage: always include multiSelect (zod default) so the
    // UI doesn't have to defend against undefined.
    const normalizedQuestions = input.questions.map((q) => ({
      question: q.question,
      header: q.header,
      multiSelect: q.multiSelect ?? false,
      options: q.options.map((o) => ({ label: o.label, description: o.description })),
    }));

    await db.insert(teamMessages).values({
      id: messageId,
      teamId,
      conversationId,
      runId: runId ?? null,
      fromMemberId: currentMemberId,
      toMemberId: null, // null = founder
      type: 'agent_text',
      messageType: 'ask_user_question',
      content: previewContent,
      metadata: { questions: normalizedQuestions },
      createdAt,
    });

    try {
      const pub = getPubSubPublisher();
      await pub.publish(
        teamMessagesChannel(teamId),
        JSON.stringify({
          messageId,
          conversationId,
          runId: runId ?? null,
          from: currentMemberId,
          to: null,
          type: 'agent_text',
          messageType: 'ask_user_question',
          content: previewContent,
          metadata: { questions: normalizedQuestions },
          createdAt: createdAt.toISOString(),
        }),
      );
    } catch (err) {
      log.warn(
        `Redis publish failed for AskUserQuestion ${messageId}; SSE subscribers will miss live delivery: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    return { asked: true, questionMessageId: messageId };
  },
});
```

- [ ] **Step 4: Run tests, verify all PASS**

```bash
pnpm vitest run src/tools/AskUserQuestionTool/__tests__/AskUserQuestionTool.test.ts
```

Expected: 11/11 pass.

- [ ] **Step 5: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/AskUserQuestionTool/
git commit -m "feat(tools): add AskUserQuestion — agent → founder structured question"
```

---

## Task 3: Register the tool

**Files:**
- Modify: `src/tools/registry-team.ts`

- [ ] **Step 1: Add the import + registration**

Open `src/tools/registry-team.ts`. After the existing `import { sleepTool } from './SleepTool/SleepTool';` line, add:

```typescript
import { askUserQuestionTool } from './AskUserQuestionTool/AskUserQuestionTool';
```

Then in the `registerDeferredTools({...})` call object, add `askUserQuestionTool` to the same alphabetical position the rest of the file uses (looks like the file is order-by-add, not alphabetical — append at end is fine):

```typescript
registerDeferredTools({
  taskTool,
  sendMessageTool,
  skillTool,
  taskStopTool,
  sleepTool,
  askUserQuestionTool,
});
```

- [ ] **Step 2: Verify the registry exposes it**

```bash
grep -n "askUserQuestion" src/tools/registry.ts
```

If the registry uses a name-keyed map (looks like it from the deferred-tools pattern), the new entry should be picked up automatically. If not, add the corresponding case explicitly — read the file:

```bash
sed -n '1,80p' src/tools/registry.ts
```

Update if needed.

- [ ] **Step 3: Type-check**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 4: Quick integration smoke**

Write a one-shot script to confirm the tool is reachable from a fake team-run context:

```bash
pnpm tsx -e "
  import('./src/tools/registry-team.js');
  import('./src/tools/registry.js').then(({ getRegisteredTool }) => {
    const t = getRegisteredTool('AskUserQuestion');
    console.log(t ? 'OK: tool registered' : 'FAIL: tool missing');
  });
"
```

Expected: `OK: tool registered`. (If `getRegisteredTool` isn't the actual export name, grep for the right one in `registry.ts` and substitute.)

- [ ] **Step 5: Commit**

```bash
git add src/tools/registry-team.ts
git commit -m "feat(tools): register AskUserQuestion in deferred tool pool"
```

---

## Task 4: Add tool to coordinator + social-media-manager AGENT.md

**Files:**
- Modify: `src/tools/AgentTool/agents/coordinator/AGENT.md`
- Modify: `src/tools/AgentTool/agents/coordinator/references/decision-examples.md`
- Modify: `src/tools/AgentTool/agents/social-media-manager/AGENT.md`
- Modify: `src/tools/AgentTool/agents/social-media-manager/references/patterns-and-examples.md`

The coordinator is the primary user (clarifying ambiguous founder intent). The social-media-manager gets it for narrow voice/channel tie-breaks.

- [ ] **Step 1: Add `AskUserQuestion` to coordinator's tool list**

Open `src/tools/AgentTool/agents/coordinator/AGENT.md`. The frontmatter currently has:

```yaml
tools:
  - Task
  - SendMessage
  - query_team_status
  - query_plan_items
  - query_strategic_path
  - generate_strategic_path
  - add_plan_item
  - update_plan_item
  - StructuredOutput
```

Insert `AskUserQuestion` directly after `SendMessage`:

```yaml
tools:
  - Task
  - SendMessage
  - AskUserQuestion
  - query_team_status
  ...
```

Add to the `references:` list:

```yaml
references:
  - decision-examples
  - when-to-handle-directly
  - three-mode-decision
  - continue-vs-spawn
  - sendmessage-rules
  - ask-user-question-when-to-use
```

- [ ] **Step 2: Create the new reference doc**

Create `src/tools/AgentTool/agents/coordinator/references/ask-user-question-when-to-use.md`:

```markdown
# When to use AskUserQuestion

Use it when you genuinely need a decision from the founder before continuing.
Skip it when:

- A reasonable default exists and the founder will steer if it's wrong.
- The question can wait until your next natural founder-facing summary.
- You're tempted to ask "should I start?" — just start; the founder steers via SendMessage.

## Good examples

### Pattern: ambiguous launch trigger

The founder said "ship the v2 thing" and there are two open `content_post` plan_items
both tagged "v2". Don't guess.

You: AskUserQuestion({
  questions: [{
    question: 'Which v2 post should I prioritize?',
    header: 'Ship target',
    options: [
      { label: 'API redesign', description: 'plan item p7-api · scheduled Tue' },
      { label: 'Pricing v2',   description: 'plan item p9-price · scheduled Wed' },
    ],
  }],
})

You then end your turn. The founder picks one; their answer arrives as your
next user message (`messageType=user_answer`); proceed with that pick.

### Pattern: voice tie-break before drafting at scale

About to ask social-media-manager to draft 5 posts on a sensitive topic
where the brand voice could land two ways. One AskUserQuestion saves five
revise loops.

You: AskUserQuestion({
  questions: [{
    question: 'How direct should we be about competitor X in this week\\'s posts?',
    header: 'Voice tone',
    options: [
      { label: 'Name them', description: 'reference X by name in 1-2 posts' },
      { label: 'Indirect',  description: 'allude to "the incumbent" without naming' },
      { label: 'Skip',      description: 'no competitor mentions this week' },
    ],
  }],
})

## Bad examples (don't ask these)

- "Should I do my job?" — just do it. Founder steers via SendMessage if not.
- "Is the plan ready?" — that's plan-mode approval territory; not for this tool.
- "Do you like this draft?" — drafts go to /briefing for review, not to a question.

## Hard rules

- 1–4 questions per call, 2–4 options each. Don't bundle unrelated questions.
- After calling, end your turn. The next thing in your inbox will be the answer.
- If the founder picks "Other" and types free text, you still get it as a normal
  user message — handle it the same way.
```

- [ ] **Step 3: Update coordinator's decision-examples reference**

Open `src/tools/AgentTool/agents/coordinator/references/decision-examples.md`. Add a new section near the end (don't disturb existing examples):

```markdown
### Example: ambiguous founder request → AskUserQuestion before delegating

User: "draft something about the new pricing"

You realize there are TWO active pricing-related plan items and a `pricing-v2`
launch happening tomorrow — the request could mean any of three things.

Don't guess and spawn social-media-manager with the wrong target. Ask:

You: AskUserQuestion({
  questions: [{
    question: 'Which pricing topic for the draft?',
    header: 'Pricing topic',
    options: [
      { label: 'v2 launch teaser', description: 'tease the price change going live tomorrow' },
      { label: 'free tier explainer', description: 'standalone post explaining the new free tier' },
      { label: 'comparison vs X', description: 'side-by-side with competitor X' },
    ],
  }],
})

(turn ends; founder picks; their answer wakes you)

You: Task({ subagent_type: 'social-media-manager', description: 'draft pricing post', prompt: '...' })
```

- [ ] **Step 4: Add `AskUserQuestion` to social-media-manager's tool list**

Open `src/tools/AgentTool/agents/social-media-manager/AGENT.md`. The frontmatter (per Plan 3 Task 2) has:

```yaml
tools:
  - find_threads_via_xai
  - find_threads
  - process_replies_batch
  - process_posts_batch
  - query_plan_items
  - query_product_context
  - read_memory
  - SendMessage
  - StructuredOutput
```

Insert `AskUserQuestion` after `SendMessage`:

```yaml
  - SendMessage
  - AskUserQuestion
  - StructuredOutput
```

- [ ] **Step 5: Update social-media-manager's patterns-and-examples**

Open `src/tools/AgentTool/agents/social-media-manager/references/patterns-and-examples.md`. Append a new pattern:

```markdown
### Pattern: voice tie-break with the founder

You're about to draft replies for 3 threads where the brand voice could
plausibly land two ways (e.g. self-deprecating vs confident on the same
topic). Burning 3 REVISE retries on each is wasteful — ask once.

You: AskUserQuestion({
  questions: [{
    question: 'For these threads about our outage, which voice?',
    header: 'Voice',
    options: [
      { label: 'Confident', description: 'own the fix, project competence' },
      { label: 'Humble',    description: 'acknowledge fault, thank reporters' },
    ],
  }],
})

(turn ends; founder picks; you receive the answer as your next user message)

You: process_replies_batch({ threadIds: ['t1', 't2', 't3'], voice: 'humble' })

When NOT to ask: routine drafting, draft-by-draft preference (those go through
validating-draft + REVISE, not founder asks).
```

- [ ] **Step 6: Run loader-smoke tests for both agents**

```bash
pnpm vitest run src/tools/AgentTool/agents/coordinator/ src/tools/AgentTool/agents/social-media-manager/
```

Expected: PASS. The loader smoke test in social-media-manager (Plan 3 Task 2) asserts `def.tools` includes the listed names. If it has a `not.toContain('AskUserQuestion')` assertion (it shouldn't — Plan 3 didn't know about this), update it to `toContain('AskUserQuestion')`.

- [ ] **Step 7: Commit**

```bash
git add src/tools/AgentTool/agents/coordinator/ \
        src/tools/AgentTool/agents/social-media-manager/
git commit -m "feat(agents): teach coordinator + social-media-manager to use AskUserQuestion"
```

---

## Task 5: API route to receive answers

**Files:**
- Create: `src/app/api/team/conversations/[conversationId]/answer/route.ts`
- Test: `src/app/api/team/conversations/[conversationId]/answer/__tests__/route.test.ts`

The founder's answer takes the same path as a normal user message back to the agent: insert a `team_messages` row addressed to the asking agent's run, then `wake()` it.

- [ ] **Step 1: Write the failing route tests**

Create `src/app/api/team/conversations/[conversationId]/answer/__tests__/route.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import {
  teamMessages,
  teams,
  teamMembers,
  teamConversations,
  agentRuns,
} from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { POST } from '../route';

vi.mock('@/lib/auth', () => ({
  getCurrentUserId: vi.fn(async () => 'test-user'),
}));

vi.mock('@/workers/processors/lib/wake', () => ({
  wake: vi.fn(async () => undefined),
}));

describe('POST /api/team/conversations/[conversationId]/answer', () => {
  let teamId: string;
  let memberId: string;
  let conversationId: string;
  let agentRunId: string;
  let questionId: string;

  beforeEach(async () => {
    teamId = crypto.randomUUID();
    memberId = crypto.randomUUID();
    conversationId = crypto.randomUUID();
    agentRunId = crypto.randomUUID();
    questionId = crypto.randomUUID();

    await db.insert(teams).values({ id: teamId, ownerId: 'test-user' });
    await db.insert(teamMembers).values({
      id: memberId,
      teamId,
      agentType: 'coordinator',
      displayName: 'Coordinator',
      role: 'lead',
    });
    await db.insert(teamConversations).values({
      id: conversationId,
      teamId,
      title: 'Test',
    });
    await db.insert(agentRuns).values({
      id: agentRunId,
      teamId,
      memberId,
      agentDefName: 'coordinator',
      status: 'sleeping',
    });
    await db.insert(teamMessages).values({
      id: questionId,
      teamId,
      conversationId,
      fromMemberId: memberId,
      toMemberId: null,
      type: 'agent_text',
      messageType: 'ask_user_question',
      content: 'Ship?',
      metadata: { questions: [{ question: 'Ship?', header: 'H', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
    });
  });

  it('inserts a user_answer row and returns 200', async () => {
    const req = new NextRequest('http://test/answer', {
      method: 'POST',
      body: JSON.stringify({
        questionMessageId: questionId,
        answers: { 'Ship?': 'Yes' },
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ conversationId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.answerMessageId).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await db
      .select()
      .from(teamMessages)
      .where(eq(teamMessages.id, body.answerMessageId))
      .limit(1);
    expect(rows.length).toBe(1);
    expect(rows[0].messageType).toBe('user_answer');
    expect(rows[0].type).toBe('user_prompt');
    expect(rows[0].repliesToId).toBe(questionId);
    expect(rows[0].toAgentId).toBe(agentRunId);
    expect(rows[0].fromMemberId).toBeNull(); // null = founder
    expect(rows[0].content).toContain('Yes');
  });

  it('wakes the asking agent', async () => {
    const { wake } = await import('@/workers/processors/lib/wake');
    const req = new NextRequest('http://test/answer', {
      method: 'POST',
      body: JSON.stringify({
        questionMessageId: questionId,
        answers: { 'Ship?': 'No' },
      }),
    });
    await POST(req, { params: Promise.resolve({ conversationId }) });
    expect(wake).toHaveBeenCalledWith(agentRunId);
  });

  it('returns 404 when questionMessageId does not exist', async () => {
    const req = new NextRequest('http://test/answer', {
      method: 'POST',
      body: JSON.stringify({
        questionMessageId: 'nonexistent',
        answers: { foo: 'bar' },
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ conversationId }) });
    expect(res.status).toBe(404);
  });

  it('returns 400 when questionMessageId belongs to a different conversation', async () => {
    const otherConv = crypto.randomUUID();
    await db.insert(teamConversations).values({ id: otherConv, teamId, title: 'Other' });
    const req = new NextRequest('http://test/answer', {
      method: 'POST',
      body: JSON.stringify({
        questionMessageId: questionId,
        answers: { 'Ship?': 'Yes' },
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ conversationId: otherConv }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the message is not actually an ask_user_question', async () => {
    const wrongId = crypto.randomUUID();
    await db.insert(teamMessages).values({
      id: wrongId,
      teamId,
      conversationId,
      fromMemberId: memberId,
      toMemberId: null,
      type: 'agent_text',
      messageType: 'message',
      content: 'plain text',
    });
    const req = new NextRequest('http://test/answer', {
      method: 'POST',
      body: JSON.stringify({
        questionMessageId: wrongId,
        answers: { foo: 'bar' },
      }),
    });
    const res = await POST(req, { params: Promise.resolve({ conversationId }) });
    expect(res.status).toBe(400);
  });

  it('returns 409 when an answer for this question already exists (idempotent)', async () => {
    const req1 = new NextRequest('http://test/answer', {
      method: 'POST',
      body: JSON.stringify({
        questionMessageId: questionId,
        answers: { 'Ship?': 'Yes' },
      }),
    });
    const res1 = await POST(req1, { params: Promise.resolve({ conversationId }) });
    expect(res1.status).toBe(200);

    const req2 = new NextRequest('http://test/answer', {
      method: 'POST',
      body: JSON.stringify({
        questionMessageId: questionId,
        answers: { 'Ship?': 'No' },
      }),
    });
    const res2 = await POST(req2, { params: Promise.resolve({ conversationId }) });
    expect(res2.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run tests, verify FAIL**

```bash
pnpm vitest run src/app/api/team/conversations/\[conversationId\]/answer/__tests__/route.test.ts
```

Expected: failures (route doesn't exist).

- [ ] **Step 3: Implement the route**

Create `src/app/api/team/conversations/[conversationId]/answer/route.ts`:

```typescript
// Founder UI POSTs here when answering an ask_user_question. We INSERT a
// user_answer row addressed to the asking agent's agent_runs.id and wake()
// it — same shape as a regular user-prompt-to-lead, with repliesToId
// chained back to the original question for UI grouping.
//
// Idempotent on (questionMessageId): a second POST returns 409 so the UI
// can disable the buttons after the first successful click without races.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { teamMessages, agentRuns, teamConversations } from '@/lib/db/schema';
import { getCurrentUserId } from '@/lib/auth';
import { wake } from '@/workers/processors/lib/wake';
import { getPubSubPublisher } from '@/lib/redis';
import { teamMessagesChannel } from '@/tools/SendMessageTool/SendMessageTool';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:team:answer');

const BodySchema = z.object({
  questionMessageId: z.string().min(1),
  answers: z.record(z.string(), z.string()),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ conversationId: string }> },
): Promise<NextResponse> {
  const { conversationId } = await ctx.params;
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { questionMessageId, answers } = parsed.data;

  // 1. Verify the question exists, belongs to this conversation,
  //    and is actually an ask_user_question.
  const questionRows = await db
    .select()
    .from(teamMessages)
    .where(eq(teamMessages.id, questionMessageId))
    .limit(1);
  if (questionRows.length === 0) {
    return NextResponse.json({ error: 'question not found' }, { status: 404 });
  }
  const question = questionRows[0];
  if (question.conversationId !== conversationId) {
    return NextResponse.json(
      { error: 'question does not belong to this conversation' },
      { status: 400 },
    );
  }
  if (question.messageType !== 'ask_user_question') {
    return NextResponse.json(
      { error: 'message is not an ask_user_question' },
      { status: 400 },
    );
  }

  // 2. Verify ownership: founder must own the team.
  const conv = await db
    .select({ teamId: teamConversations.teamId })
    .from(teamConversations)
    .where(eq(teamConversations.id, conversationId))
    .limit(1);
  if (conv.length === 0) {
    return NextResponse.json({ error: 'conversation not found' }, { status: 404 });
  }

  // 3. Idempotency check — has this question already been answered?
  const existingAnswer = await db
    .select({ id: teamMessages.id })
    .from(teamMessages)
    .where(
      and(
        eq(teamMessages.repliesToId, questionMessageId),
        eq(teamMessages.messageType, 'user_answer'),
      ),
    )
    .limit(1);
  if (existingAnswer.length > 0) {
    return NextResponse.json(
      { error: 'question already answered', existingAnswerId: existingAnswer[0].id },
      { status: 409 },
    );
  }

  // 4. Resolve the asking agent's live agent_runs.id. We address by
  //    fromMemberId of the question — that's the agent that asked.
  //    Pick the most-recently-active addressable run for that member.
  const asker = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.memberId, question.fromMemberId!),
        inArray(agentRuns.status, ['running', 'sleeping']),
      ),
    )
    .orderBy(desc(agentRuns.lastActiveAt))
    .limit(1);
  // It's OK for asker to be empty (e.g. agent crashed before answer arrived) —
  // we still write the user_answer row so the conversation is complete. The
  // dead agent won't be woken; if a new run starts later it will see the
  // answer in its mailbox via the same `to_agent_id IS NULL` fallback path
  // any user_prompt without a target gets.
  const targetAgentId = asker[0]?.id ?? null;

  // 5. Format the user-facing answer string. Multi-question answers are
  //    joined with " · " for the agent's transcript.
  const answerEntries = Object.entries(answers);
  const content = answerEntries
    .map(([q, a]) => `${q} → ${a}`)
    .join(' · ');

  // 6. Insert the answer.
  const answerMessageId = crypto.randomUUID();
  const createdAt = new Date();
  await db.insert(teamMessages).values({
    id: answerMessageId,
    teamId: conv[0].teamId,
    conversationId,
    runId: question.runId,
    fromMemberId: null, // null = founder
    toMemberId: question.fromMemberId,
    toAgentId: targetAgentId,
    type: 'user_prompt',
    messageType: 'user_answer',
    content,
    metadata: { answers },
    repliesToId: questionMessageId,
    createdAt,
  });

  // 7. Wake the asking agent so it processes the answer at its next idle.
  if (targetAgentId) {
    try {
      await wake(targetAgentId);
    } catch (err) {
      // Wake failure isn't fatal — the answer is durably recorded; the agent
      // will pick it up at its next reconcile-mailbox tick.
      log.warn(
        `wake failed for agent ${targetAgentId}; answer ${answerMessageId} still durable: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // 8. Publish to Redis for live SSE delivery to /team observers.
  try {
    const pub = getPubSubPublisher();
    await pub.publish(
      teamMessagesChannel(conv[0].teamId),
      JSON.stringify({
        messageId: answerMessageId,
        conversationId,
        runId: question.runId,
        from: null,
        to: question.fromMemberId,
        content,
        createdAt: createdAt.toISOString(),
        type: 'user_prompt',
        messageType: 'user_answer',
        repliesToId: questionMessageId,
      }),
    );
  } catch (err) {
    log.warn(
      `Redis publish for user_answer ${answerMessageId} failed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  return NextResponse.json({ answerMessageId }, { status: 200 });
}
```

- [ ] **Step 4: Run tests, verify all PASS**

```bash
pnpm vitest run src/app/api/team/conversations/\[conversationId\]/answer/__tests__/route.test.ts
```

Expected: 6/6 pass.

- [ ] **Step 5: Type-check**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/app/api/team/conversations/\[conversationId\]/answer/
git commit -m "feat(api): POST /api/team/conversations/[id]/answer — receive founder answers and wake the asking agent"
```

---

## Task 6: QuestionCard UI component

**Files:**
- Create: `src/app/(app)/team/_components/question-card.tsx`
- Test: `src/app/(app)/team/_components/__tests__/question-card.test.tsx`

A React Server Component is wrong here — this needs client interactivity (button picks, "Other" text input, optimistic disabling). Build it as a client component that takes the structured payload + a callback that POSTs to the API.

- [ ] **Step 1: Write the failing component test**

Create `src/app/(app)/team/_components/__tests__/question-card.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QuestionCard, type QuestionPayload } from '../question-card';

const onePayload: QuestionPayload = {
  questions: [
    {
      question: 'Ship now or wait?',
      header: 'Ship timing',
      multiSelect: false,
      options: [
        { label: 'Ship', description: 'push to prod immediately' },
        { label: 'Wait', description: 'hold until tomorrow' },
      ],
    },
  ],
};

const multiPayload: QuestionPayload = {
  questions: [
    {
      question: 'Which channels?',
      header: 'Channels',
      multiSelect: true,
      options: [
        { label: 'X', description: 'X (twitter)' },
        { label: 'Reddit', description: 'r/SaaS + r/Entrepreneur' },
        { label: 'LinkedIn', description: 'company page' },
      ],
    },
  ],
};

describe('QuestionCard', () => {
  it('renders the question text and all options', () => {
    render(
      <QuestionCard
        questionMessageId="q1"
        conversationId="c1"
        payload={onePayload}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText('Ship now or wait?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Ship/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Wait/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Other/ })).toBeInTheDocument();
  });

  it('renders the option description below each label', () => {
    render(
      <QuestionCard
        questionMessageId="q1"
        conversationId="c1"
        payload={onePayload}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText('push to prod immediately')).toBeInTheDocument();
    expect(screen.getByText('hold until tomorrow')).toBeInTheDocument();
  });

  it('single-select: clicking an option calls onSubmit with that label', async () => {
    const onSubmit = vi.fn();
    render(
      <QuestionCard
        questionMessageId="q1"
        conversationId="c1"
        payload={onePayload}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Ship/ }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        'Ship now or wait?': 'Ship',
      }),
    );
  });

  it('multi-select: requires explicit Submit button to confirm picks', async () => {
    const onSubmit = vi.fn();
    render(
      <QuestionCard
        questionMessageId="q2"
        conversationId="c1"
        payload={multiPayload}
        onSubmit={onSubmit}
      />,
    );
    // Picking one option should NOT auto-submit in multi-select mode
    fireEvent.click(screen.getByRole('button', { name: /^X/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Reddit/ }));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        'Which channels?': 'X, Reddit',
      }),
    );
  });

  it('Other reveals a text input and submits its value', async () => {
    const onSubmit = vi.fn();
    render(
      <QuestionCard
        questionMessageId="q1"
        conversationId="c1"
        payload={onePayload}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Other/ }));
    const input = screen.getByPlaceholderText(/your answer/i);
    fireEvent.change(input, { target: { value: 'I want a third option' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        'Ship now or wait?': 'I want a third option',
      }),
    );
  });

  it('disables all controls after submission (optimistic)', async () => {
    const onSubmit = vi.fn(() => new Promise<void>((r) => setTimeout(r, 100)));
    render(
      <QuestionCard
        questionMessageId="q1"
        conversationId="c1"
        payload={onePayload}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Ship/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Ship/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /^Wait/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /^Other/ })).toBeDisabled();
    });
  });

  it('renders an answered state when answeredWith is provided', () => {
    render(
      <QuestionCard
        questionMessageId="q1"
        conversationId="c1"
        payload={onePayload}
        onSubmit={vi.fn()}
        answeredWith={{ 'Ship now or wait?': 'Ship' }}
      />,
    );
    // Buttons are gone; collapsed pill instead
    expect(screen.queryByRole('button', { name: /^Ship$/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Ship now or wait\? → Ship/)).toBeInTheDocument();
  });

  it('renders the chip header from question.header', () => {
    render(
      <QuestionCard
        questionMessageId="q1"
        conversationId="c1"
        payload={onePayload}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText('Ship timing')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests, verify FAIL**

```bash
pnpm vitest run src/app/\(app\)/team/_components/__tests__/question-card.test.tsx
```

Expected: failures (component doesn't exist).

- [ ] **Step 3: Implement the component**

Create `src/app/(app)/team/_components/question-card.tsx`:

```tsx
'use client';

import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';

export interface QuestionOptionUI {
  label: string;
  description: string;
}

export interface QuestionUI {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOptionUI[];
}

export interface QuestionPayload {
  questions: QuestionUI[];
}

export type AnswerMap = Record<string, string>;

interface QuestionCardProps {
  questionMessageId: string;
  conversationId: string;
  payload: QuestionPayload;
  /** Async submit handler. The component disables itself while this resolves. */
  onSubmit: (answers: AnswerMap) => Promise<void> | void;
  /** When set, render the collapsed answered state instead of the picker. */
  answeredWith?: AnswerMap;
}

export function QuestionCard(props: QuestionCardProps) {
  const { payload, onSubmit, answeredWith } = props;

  // Per-question selection state. For single-select: 0 or 1 entries. For
  // multi-select: 0..N entries. "Other" picks live in `otherText` instead.
  const [picks, setPicks] = useState<Record<string, Set<string>>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(
    async (overrides?: AnswerMap) => {
      if (submitting || answeredWith) return;
      setSubmitting(true);
      const answers: AnswerMap = overrides ?? {};
      if (!overrides) {
        for (const q of payload.questions) {
          if (otherOpen[q.question] && otherText[q.question]?.trim()) {
            answers[q.question] = otherText[q.question].trim();
          } else {
            const selected = Array.from(picks[q.question] ?? []);
            if (selected.length === 0) {
              setSubmitting(false);
              return; // Block submit when nothing's picked.
            }
            answers[q.question] = selected.join(', ');
          }
        }
      }
      try {
        await onSubmit(answers);
      } finally {
        // Stay disabled — parent will re-render with answeredWith on success,
        // or the founder can retry on error (TODO: surface an error toast).
      }
    },
    [submitting, answeredWith, payload.questions, picks, otherText, otherOpen, onSubmit],
  );

  const togglePick = useCallback(
    (question: QuestionUI, label: string) => {
      if (submitting || answeredWith) return;
      setPicks((prev) => {
        const cur = new Set(prev[question.question] ?? []);
        if (question.multiSelect) {
          if (cur.has(label)) cur.delete(label);
          else cur.add(label);
        } else {
          cur.clear();
          cur.add(label);
        }
        return { ...prev, [question.question]: cur };
      });
      setOtherOpen((prev) => ({ ...prev, [question.question]: false }));

      // Single-select with no "Other" selected → auto-submit on click for snappy UX
      if (!question.multiSelect) {
        // Use a microtask so React state updates flush before submit reads picks
        queueMicrotask(() => {
          if (!otherOpen[question.question]) {
            submit({ [question.question]: label });
          }
        });
      }
    },
    [submitting, answeredWith, otherOpen, submit],
  );

  const openOther = useCallback(
    (question: QuestionUI) => {
      if (submitting || answeredWith) return;
      setPicks((prev) => ({ ...prev, [question.question]: new Set() }));
      setOtherOpen((prev) => ({ ...prev, [question.question]: true }));
    },
    [submitting, answeredWith],
  );

  // ----- Answered state (collapsed pill view) -----
  if (answeredWith) {
    return (
      <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">
        {Object.entries(answeredWith).map(([q, a]) => (
          <div key={q}>
            {q} → <strong>{a}</strong>
          </div>
        ))}
      </div>
    );
  }

  // ----- Picker state -----
  const showSubmitButton = payload.questions.some((q) => q.multiSelect);

  return (
    <div className="rounded-md border border-zinc-200 bg-white p-4 space-y-4 shadow-sm">
      {payload.questions.map((q) => (
        <fieldset key={q.question} className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="inline-block rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700">
              {q.header}
            </span>
            <legend className="text-sm font-medium text-zinc-900">
              {q.question}
            </legend>
          </div>
          <div className="space-y-1.5">
            {q.options.map((opt) => {
              const isPicked = picks[q.question]?.has(opt.label) ?? false;
              return (
                <button
                  key={opt.label}
                  type="button"
                  disabled={submitting}
                  onClick={() => togglePick(q, opt.label)}
                  className={cn(
                    'block w-full rounded border px-3 py-2 text-left text-sm transition-colors',
                    isPicked
                      ? 'border-blue-500 bg-blue-50 text-blue-900'
                      : 'border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50',
                    submitting && 'opacity-50 cursor-not-allowed',
                  )}
                >
                  <div className="font-medium">{opt.label}</div>
                  {opt.description && (
                    <div className="text-xs text-zinc-500">{opt.description}</div>
                  )}
                </button>
              );
            })}
            <button
              type="button"
              disabled={submitting}
              onClick={() => openOther(q)}
              className={cn(
                'block w-full rounded border border-dashed border-zinc-300 px-3 py-2 text-left text-sm text-zinc-600 hover:bg-zinc-50',
                submitting && 'opacity-50 cursor-not-allowed',
              )}
            >
              Other (type your own answer)
            </button>
            {otherOpen[q.question] && (
              <div className="flex gap-2 mt-2">
                <input
                  type="text"
                  placeholder="Your answer..."
                  disabled={submitting}
                  value={otherText[q.question] ?? ''}
                  onChange={(e) =>
                    setOtherText((prev) => ({ ...prev, [q.question]: e.target.value }))
                  }
                  className="flex-1 rounded border border-zinc-300 px-3 py-1.5 text-sm"
                />
                <button
                  type="button"
                  disabled={submitting || !otherText[q.question]?.trim()}
                  onClick={() =>
                    submit({ [q.question]: (otherText[q.question] ?? '').trim() })
                  }
                  className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            )}
          </div>
        </fieldset>
      ))}
      {showSubmitButton && (
        <button
          type="button"
          disabled={submitting}
          onClick={() => submit()}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Submit
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests, verify all PASS**

```bash
pnpm vitest run src/app/\(app\)/team/_components/__tests__/question-card.test.tsx
```

Expected: 8/8 pass. If the multi-select submit-button test fails because the auto-submit on first click fires, that's the bug to fix in `togglePick` — single-select auto-submits, multi-select must not.

- [ ] **Step 5: Type-check**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/team/_components/question-card.tsx \
        src/app/\(app\)/team/_components/__tests__/question-card.test.tsx
git commit -m "feat(ui): QuestionCard component for AskUserQuestion picker + answered state"
```

---

## Task 7: Wire QuestionCard into the conversation thread

**Files:**
- Modify: `src/app/(app)/team/_components/conversation-reducer.ts`
- Modify: `src/app/(app)/team/_components/conversation.tsx`
- Modify: `src/hooks/use-team-events.ts` (if event types are typed; otherwise no-op)

This is the integration point. The reducer needs a new node type `'question'` and `'question-answer'`; the renderer maps those to `<QuestionCard>` instances; the SSE listener already publishes the rows so no client-side wiring is needed beyond rendering.

- [ ] **Step 1: Read the current reducer's node types and stitcher**

```bash
sed -n '1,180p' src/app/\(app\)/team/_components/conversation-reducer.ts | head -180
grep -n "messageType\|type:" src/app/\(app\)/team/_components/conversation-reducer.ts | head -40
```

The reducer currently has node types `'user' | 'lead' | 'activity'` (and possibly `'session-divider'`). We add `'question'` for `messageType='ask_user_question'` rows and stitch the matching `messageType='user_answer'` row onto it as `answeredWith`.

- [ ] **Step 2: Extend the node type**

In `src/app/(app)/team/_components/conversation-reducer.ts`, after the existing `LeadNode` / `UserNode` interfaces, add:

```typescript
export interface QuestionNode {
  kind: 'question';
  id: string; // team_messages.id of the ask_user_question row
  createdAt: string;
  conversationId: string;
  payload: {
    questions: Array<{
      question: string;
      header: string;
      multiSelect: boolean;
      options: Array<{ label: string; description: string }>;
    }>;
  };
  /** Populated when a matching user_answer row exists (joined by repliesToId). */
  answeredWith: Record<string, string> | null;
}
```

Update the discriminated `ConversationNode` union to include `QuestionNode`:

```typescript
export type ConversationNode =
  | UserNode
  | LeadNode
  | ActivityNode
  | QuestionNode;
```

- [ ] **Step 3: Add stitching logic**

In the same file, find the function that converts raw `team_messages` rows into nodes (likely `buildConversationNodes` or similar — grep for the loop over rows). Add handling for `messageType === 'ask_user_question'`:

```typescript
// In the row-loop:
if (row.messageType === 'ask_user_question') {
  const payload = (row.metadata as { questions?: QuestionNode['payload']['questions'] } | null)
    ?.questions;
  if (!payload) continue; // malformed — skip
  nodes.push({
    kind: 'question',
    id: row.id,
    createdAt: row.createdAt,
    conversationId: row.conversationId!,
    payload: { questions: payload },
    answeredWith: null, // filled in by post-processing
  });
  continue;
}

if (row.messageType === 'user_answer') {
  // Don't render the answer as a separate node — instead, find its matching
  // question node and attach. Skip rendering as user message.
  continue;
}
```

After the main loop builds `nodes`, add a post-processing pass to attach answers:

```typescript
// Build a lookup of user_answer rows by repliesToId so question nodes can
// claim their answer. Done as a second pass because rows may arrive out of
// order via SSE (answer can arrive before its question if the founder is
// fast enough on a stale tab — though in practice this is rare).
const answersByQuestionId = new Map<string, Record<string, string>>();
for (const row of rows) {
  if (row.messageType === 'user_answer' && row.repliesToId) {
    const ans = (row.metadata as { answers?: Record<string, string> } | null)?.answers;
    if (ans) answersByQuestionId.set(row.repliesToId, ans);
  }
}
for (const node of nodes) {
  if (node.kind === 'question') {
    const ans = answersByQuestionId.get(node.id);
    if (ans) node.answeredWith = ans;
  }
}
```

- [ ] **Step 4: Update conversation.tsx to render the new node**

Open `src/app/(app)/team/_components/conversation.tsx`. Find the switch / map over `ConversationNode` (likely keyed by `node.kind`). Add a case for `'question'`:

```tsx
import { QuestionCard } from './question-card';

// ... inside the renderer switch:
case 'question':
  return (
    <QuestionCard
      key={node.id}
      questionMessageId={node.id}
      conversationId={node.conversationId}
      payload={node.payload}
      answeredWith={node.answeredWith ?? undefined}
      onSubmit={async (answers) => {
        const res = await fetch(
          `/api/team/conversations/${node.conversationId}/answer`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              questionMessageId: node.id,
              answers,
            }),
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        // Don't optimistically update — the SSE event from the API will
        // re-render with answeredWith populated. This keeps the source of
        // truth on the server.
      }}
    />
  );
```

- [ ] **Step 5: Run reducer tests**

```bash
pnpm vitest run src/app/\(app\)/team/_components/__tests__/conversation-reducer.test.ts
```

The existing test file may not cover the new node types; add a minimal smoke for the stitcher:

```typescript
// Append to src/app/(app)/team/_components/__tests__/conversation-reducer.test.ts
describe('conversation-reducer — ask_user_question stitching', () => {
  it('builds a question node with payload from metadata', () => {
    const rows = [
      {
        id: 'q1',
        teamId: 't',
        conversationId: 'c',
        createdAt: '2026-05-04T10:00:00Z',
        type: 'agent_text',
        messageType: 'ask_user_question',
        content: 'Ship?',
        metadata: {
          questions: [
            {
              question: 'Ship?',
              header: 'H',
              multiSelect: false,
              options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
            },
          ],
        },
        fromMemberId: 'm1',
        toMemberId: null,
      },
    ];
    const nodes = buildConversationNodes(rows as never);
    const q = nodes.find((n) => n.kind === 'question');
    expect(q).toBeDefined();
    expect(q!.kind).toBe('question');
    expect((q as QuestionNode).answeredWith).toBeNull();
  });

  it('attaches a user_answer row to its question via repliesToId', () => {
    const rows = [
      {
        id: 'q1',
        teamId: 't',
        conversationId: 'c',
        createdAt: '2026-05-04T10:00:00Z',
        type: 'agent_text',
        messageType: 'ask_user_question',
        content: 'Ship?',
        metadata: { questions: [{ question: 'Ship?', header: 'H', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }] },
        fromMemberId: 'm1',
        toMemberId: null,
      },
      {
        id: 'a1',
        teamId: 't',
        conversationId: 'c',
        createdAt: '2026-05-04T10:00:30Z',
        type: 'user_prompt',
        messageType: 'user_answer',
        content: 'Ship? → Yes',
        metadata: { answers: { 'Ship?': 'Yes' } },
        repliesToId: 'q1',
        fromMemberId: null,
        toMemberId: 'm1',
      },
    ];
    const nodes = buildConversationNodes(rows as never);
    const q = nodes.find((n) => n.kind === 'question') as QuestionNode;
    expect(q.answeredWith).toEqual({ 'Ship?': 'Yes' });

    // user_answer row is NOT rendered as its own node
    expect(nodes.find((n) => 'id' in n && n.id === 'a1')).toBeUndefined();
  });
});
```

(Replace `buildConversationNodes` with whatever the actual exported function is — grep first.)

- [ ] **Step 6: Run all related tests**

```bash
pnpm vitest run src/app/\(app\)/team/
```

- [ ] **Step 7: Type-check**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add src/app/\(app\)/team/_components/conversation-reducer.ts \
        src/app/\(app\)/team/_components/conversation.tsx \
        src/app/\(app\)/team/_components/__tests__/conversation-reducer.test.ts
git commit -m "feat(ui): render QuestionCard in conversation thread; stitch user_answer rows by repliesToId"
```

---

## Task 8: Real-browser smoke test

**Files:**
- Create: `e2e/ask-user-question-smoke.spec.ts`

Connect to the user's already-authenticated Chromium (per memory `feedback_playwright_real_browser_in_plans`), trigger a coordinator scenario that produces a question, click an option, verify the agent resumes and acts on the answer.

The cleanest trigger is to seed an `ask_user_question` row directly via the API (skipping the actual agent call) and verify the UI + answer flow. A full agent-driven scenario would require nondeterministic LLM steering and isn't worth the flake budget for a smoke.

- [ ] **Step 1: Write the smoke**

Create `e2e/ask-user-question-smoke.spec.ts`:

```typescript
import { test, expect, chromium } from '@playwright/test';

test('AskUserQuestion: question renders, founder picks, answer reaches the agent', async () => {
  const browser = await chromium.connectOverCDP(
    process.env.CHROMIUM_CDP_URL ?? 'http://localhost:9222',
  );
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();

  await page.goto('http://localhost:3000/team');
  await expect(page.getByRole('heading', { name: /team/i }).first()).toBeVisible({
    timeout: 10_000,
  });

  // 1. Seed a question by calling the AskUserQuestion tool directly through
  //    a test-only endpoint. This sidesteps needing an LLM in the loop for
  //    the smoke. The test endpoint must exist; if it doesn't, add a minimal
  //    POST /api/_test/seed-question that runs the tool against the user's
  //    active conversation. Skip this test in CI; it's a local-only smoke.
  test.skip(
    !process.env.SHIPFLARE_TEST_SEED_ENABLED,
    'set SHIPFLARE_TEST_SEED_ENABLED=1 to run',
  );

  const seedRes = await page.request.post(
    'http://localhost:3000/api/_test/seed-question',
    {
      data: {
        question: 'Smoke test: ship now?',
        header: 'Ship?',
        options: [
          { label: 'Yes', description: 'ship' },
          { label: 'No', description: 'wait' },
        ],
      },
    },
  );
  expect(seedRes.ok()).toBeTruthy();
  const { questionMessageId, conversationId } = await seedRes.json();

  // 2. Navigate to the conversation and verify the question renders
  await page.goto(`http://localhost:3000/team?conversation=${conversationId}`);
  const yesBtn = page.getByRole('button', { name: /^Yes/ });
  await expect(yesBtn).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Smoke test: ship now?')).toBeVisible();

  // 3. Click an option
  await yesBtn.click();

  // 4. Verify the answered pill replaces the picker
  await expect(page.getByText(/Smoke test.*→.*Yes/)).toBeVisible({ timeout: 5_000 });

  // 5. Verify the agent received the answer (poll the messages API)
  let answerSeen = false;
  for (let i = 0; i < 10; i++) {
    const res = await page.request.get(
      `http://localhost:3000/api/team/conversations/${conversationId}/messages?after=${questionMessageId}`,
    );
    if (res.ok()) {
      const body = await res.json();
      if (body.messages?.some(
        (m: { messageType: string; repliesToId: string }) =>
          m.messageType === 'user_answer' && m.repliesToId === questionMessageId,
      )) {
        answerSeen = true;
        break;
      }
    }
    await page.waitForTimeout(500);
  }
  expect(answerSeen).toBe(true);

  // 6. Assert no console errors during the flow
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  await page.waitForLoadState('networkidle');
  expect(
    consoleErrors.filter((e) => !e.includes('favicon')),
  ).toHaveLength(0);

  await browser.close();
});
```

- [ ] **Step 2: Add the test-only seed endpoint**

The smoke needs `POST /api/_test/seed-question`. Add it as a development-only endpoint:

Create `src/app/api/_test/seed-question/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { askUserQuestionTool } from '@/tools/AskUserQuestionTool/AskUserQuestionTool';
import { getCurrentUserId } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamMembers, teamConversations, agentRuns } from '@/lib/db/schema';
import { and, desc, eq } from 'drizzle-orm';

const BodySchema = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string() })).min(2).max(4),
});

export async function POST(req: NextRequest) {
  // Dev-only guard. In prod this returns 404 to avoid surface area.
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }

  // Resolve user's team + coordinator member + most-recent conversation.
  const [team] = await db.select().from(teams).where(eq(teams.ownerId, userId)).limit(1);
  if (!team) return NextResponse.json({ error: 'no team' }, { status: 404 });

  const [coord] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.agentType, 'coordinator')))
    .limit(1);
  if (!coord) return NextResponse.json({ error: 'no coordinator' }, { status: 404 });

  const [conv] = await db
    .select()
    .from(teamConversations)
    .where(eq(teamConversations.teamId, team.id))
    .orderBy(desc(teamConversations.createdAt))
    .limit(1);
  if (!conv) return NextResponse.json({ error: 'no conversation' }, { status: 404 });

  // Ensure an agent_run exists for the coordinator (smoke needs one for wake to work later).
  let [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.memberId, coord.id), eq(agentRuns.status, 'sleeping')))
    .limit(1);
  if (!run) {
    const id = crypto.randomUUID();
    await db.insert(agentRuns).values({
      id,
      teamId: team.id,
      memberId: coord.id,
      agentDefName: 'coordinator',
      status: 'sleeping',
    });
    [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
  }

  const ctx = {
    get<T>(key: string): T {
      switch (key) {
        case 'teamId': return team.id as unknown as T;
        case 'currentMemberId': return coord.id as unknown as T;
        case 'runId': return run.id as unknown as T;
        case 'conversationId': return conv.id as unknown as T;
        default: throw new Error(`unknown ctx key: ${key}`);
      }
    },
  };

  const result = await askUserQuestionTool.execute(
    {
      questions: [
        {
          question: parsed.data.question,
          header: parsed.data.header,
          multiSelect: false,
          options: parsed.data.options,
        },
      ],
    },
    ctx as never,
  );

  return NextResponse.json({
    questionMessageId: result.questionMessageId,
    conversationId: conv.id,
  });
}
```

- [ ] **Step 3: Run the smoke locally**

Make sure dev server is running and Chrome is launched on port 9222:

```bash
# Terminal 1: dev server
SHIPFLARE_TEST_SEED_ENABLED=1 pnpm dev

# Terminal 2: launch Chrome with CDP
open -na "Google Chrome" --args --remote-debugging-port=9222

# Terminal 3: run the smoke
pnpm playwright test e2e/ask-user-question-smoke.spec.ts --reporter=list
```

Expected: PASS within 30s. If FAIL on step 1 (seed), check that the test endpoint mounted (Next.js route discovery may need a server restart). If FAIL on step 4 (answer not seen), check the `/api/team/conversations/[id]/messages` endpoint exists; if it doesn't, add a thin GET handler that returns rows after the given marker, OR replace the polling with a direct DB read using `pnpm tsx`.

- [ ] **Step 4: Commit**

```bash
git add e2e/ask-user-question-smoke.spec.ts \
        src/app/api/_test/seed-question/route.ts
git commit -m "test(e2e): real-browser smoke for AskUserQuestion question → answer → wake flow"
```

---

## Task 9: CLAUDE.md note + final verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add note under "Skill Primitive" section**

In `CLAUDE.md`, find the `## Skill Primitive` section (around the line `ShipFlare's multi-agent system has three primitives: **Tool**, **Agent**, **Skill**.`). Add a new bullet to the existing primitive enumeration OR add a one-line note in the existing prose:

```markdown
## AskUserQuestion (founder ask)

Agents can pose 1-4 multiple-choice questions to the founder via the
`AskUserQuestion` tool. The question renders inline in `/team` as a
QuestionCard with option buttons + an always-present "Other" text input.
The founder's answer flows back as a `messageType='user_answer'` mailbox
message that wakes the asking agent — same path as a normal user-prompt
reply, with `repliesToId` chained for UI grouping. After calling the
tool, the agent must end its turn; its next user-role message will be
the answer. Tool source: `src/tools/AskUserQuestionTool/`. UI source:
`src/app/(app)/team/_components/question-card.tsx`. API: `POST
/api/team/conversations/[id]/answer`.
```

- [ ] **Step 2: Greppable invariants**

```bash
# Tool registered
grep -n "askUserQuestionTool" src/tools/registry-team.ts
# Expected: 2 hits (import + value in object)

# Both agents have the tool
grep -A2 "tools:" src/tools/AgentTool/agents/coordinator/AGENT.md | grep AskUserQuestion
grep -A2 "tools:" src/tools/AgentTool/agents/social-media-manager/AGENT.md | grep AskUserQuestion
# Expected: 1 hit each

# UI component renders for the message type
grep -n "ask_user_question" src/app/\(app\)/team/_components/conversation-reducer.ts
# Expected: at least 1 hit

# API route exists
ls src/app/api/team/conversations/\[conversationId\]/answer/route.ts
# Expected: file exists

# Test endpoint is dev-only
grep -n "NODE_ENV.*production" src/app/api/_test/seed-question/route.ts
# Expected: 1 hit (the prod guard)
```

- [ ] **Step 3: Type-check + tests**

```bash
pnpm tsc --noEmit
pnpm vitest run --reporter=basic
```

Expected: 0 type errors, 0 test failures.

- [ ] **Step 4: Push**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE): document AskUserQuestion primitive and integration points"
git push -u origin HEAD
```

---

## Self-Review

**Spec coverage:**
- New tool with engine-aligned schema → Task 2 ✓
- Tool registered → Task 3 ✓
- Both agents teach the tool → Task 4 ✓
- API route to receive answers + wake the agent → Task 5 ✓
- UI component (single + multi-select + Other + answered state) → Task 6 ✓
- Conversation thread renders the card + stitches answers → Task 7 ✓
- Real-browser smoke → Task 8 ✓
- Schema doc + drain regression test → Task 1 ✓
- CLAUDE.md note → Task 9 ✓

**Placeholder scan:** No "TBD" / "implement later" / "similar to Task N" anywhere. Every code step shows the actual code.

**Type consistency:**
- `AskUserQuestionInputSchema` (Task 2) ↔ `BodySchema` validation in route.ts (Task 5) ↔ `QuestionPayload` UI type (Task 6) ↔ `QuestionNode` reducer type (Task 7) all carry the same `{questions[].options[].label/description}` shape.
- `messageType` values are spelled identically in: schema comment (Task 1), tool execute (Task 2), API route (Task 5), reducer (Task 7), drain test (Task 1). String constants — no central enum — so consistency was hand-verified above.
- `repliesToId` (existing column) is the join key everywhere a question and its answer need to find each other.

---

## Tradeoffs / risks

- **Single-question single-select auto-submits on first click.** Snappy UX, but if the founder mis-clicks they can't undo. Engine has the same behavior (the option list is one keystroke away from confirm). If this proves frustrating in practice, add a `confirmRequired: boolean` flag in v2 — don't second-guess it now.
- **Multi-question payloads share one Submit button.** When a tool call asks 3 questions at once, the founder picks across all of them then clicks Submit. Engine model is the same. Cognitively heavy; the tool's prompt steers agents toward 1 question per call as the default.
- **No timeout on pending questions.** A founder who never answers leaves the agent indefinitely sleeping. Acceptable v1 — the agent's `agent_runs` row still has `lastActiveAt`; the existing `stale-sweeper` processor handles dead runs. If the founder DM's the agent through some other route, the agent wakes and can decide to abandon the question.
- **No optimistic update on answer submit.** The UI POSTs and waits for the SSE re-render to show the answered state. Adds ~100ms perceived delay. Trade-off for not needing client-side cache reconciliation when the SSE event arrives.
- **Test seed endpoint is a real route in dev.** Production guard at the top blocks it. Risk: someone disables the guard in dev builds and ships. Mitigation: route lives under `/api/_test/`, the underscore prefix is a project convention for dev-only routes (verify this convention exists in CLAUDE.md or another route under `_test/`; if not, use a per-route header check `if (req.headers.get('x-shipflare-test-seed') !== process.env.TEST_SEED_TOKEN)`).
- **What about social-media-manager asking questions during a sweep?** The sweeper-driven path runs in BullMQ without an interactive founder watching. If `social-media-manager` calls `AskUserQuestion` during a scheduled sweep, the question lands in the conversation but no one's watching live. The next time the founder opens `/team`, they'll see it. The agent meanwhile is sleeping until either the founder answers OR a timeout / new SendMessage wakes it. This is acceptable — the agent should learn (via patterns-and-examples wording) to prefer non-blocking decisions during scheduled work.
