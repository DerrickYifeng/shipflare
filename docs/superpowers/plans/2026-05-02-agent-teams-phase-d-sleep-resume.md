# Agent Teams — Phase D: Sleep + Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `Sleep` tool that lets a teammate yield its BullMQ worker slot mid-conversation. The teammate's transcript is persisted to `team_messages`; the worker process exits; a delayed BullMQ job + any new SendMessage to the agent both wake it; on resume, the agent loads its full prior transcript and continues. Long-lived teammate conversations work without holding worker concurrency.

**Architecture:** The `Sleep` tool's execute body persists transcript state, schedules a delayed `agent-run` BullMQ job via `enqueueAgentRun({delay})`, marks `agent_runs.status='sleeping'`, and signals early-exit from runAgent. The agent-run processor extends to handle the new `sleeping → resuming → running` transitions: on a wake of a sleeping row, it loads prior conversation history (via a new `loadAgentRunHistory` helper that reads `team_messages` where `fromAgentId=self OR toAgentId=self`) and passes it as `priorMessages` to runAgent. SendMessage's `message` variant is extended to call `wake()` when the recipient's `agent_runs.status` is `sleeping` (was: only `shutdown_request` woke targets in Phase C).

**Tech Stack:** TypeScript 5, Vitest, Zod, Drizzle, BullMQ delayed jobs.

**Spec reference:** `docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md` § Phase D, §3.1 state machine.

**Phase D non-goals**:
- team-run unification (X driver) — Phase E
- KAIROS / autoDream — out of scope
- Any LLM-facing UI for sleep status — Phase F

---

## File structure

**New files (3):**

| Path | Responsibility |
|---|---|
| `src/tools/SleepTool/SleepTool.ts` | New `Sleep` tool. Input: `{duration_ms: number}`. Side effects: persist transcript marker (the actual transcript persistence happens via the agent-run loop's onTurn hook — Sleep's job is to STOP the loop and schedule the wake). Marks `agent_runs.status='sleeping' + sleepUntil`, calls `enqueueAgentRun({agentId, delay: duration_ms})`, returns a special result that the agent-run processor recognizes as "early exit, no notification" |
| `src/tools/SleepTool/__tests__/SleepTool.test.ts` | Sleep tool unit tests (5 cases) |
| `src/workers/processors/lib/agent-run-history.ts` | `loadAgentRunHistory(agentId, db): Promise<MessageParam[]>` — reads team_messages where `fromAgentId=agentId OR toAgentId=agentId AND deliveredAt IS NOT NULL`, orders by createdAt, maps to Anthropic MessageParam shape (user vs assistant role) |

**Modified files (4):**

| Path | What changes |
|---|---|
| `src/workers/processors/agent-run.ts` | Detect Sleep tool's special return → exit runAgent loop without calling synthAndDeliverNotification (the agent isn't done, just yielding). On agent_runs row load, check status: if `sleeping` → mark `resuming` then load history via `loadAgentRunHistory` and pass as `priorMessages` to runAgent. Persist each assistant turn via the onEvent callback so resume sees full history |
| `src/workers/processors/__tests__/agent-run.test.ts` | Add cases: Sleep yields without calling synthesize; resume loads history; full sleep→wake roundtrip |
| `src/tools/SendMessageTool/SendMessageTool.ts` | In `dispatchMessage`, after the primary insert, check if recipient's agent_runs.status is `sleeping` and call `wake()` if so. Already happens for shutdown_request (Phase C); extending to message |
| `src/tools/AgentTool/role-tools.ts` | Add `SLEEP_TOOL_NAME` to TEAM_LEAD + TEAMMATE whitelists; explicitly NOT to SUBAGENT (subagents must complete in-turn, no yield) |
| `src/tools/registry-team.ts` (or registry.ts) | Register `sleepTool` |

**Total:** 3 new + 5 modifications = 8 file touches across 7 tasks.

---

## Sequence + dependencies

```
Task 1 (Sleep tool definition)            ─┐
Task 2 (Sleep in whitelists + register)   ─┴─▶ Task 4 (agent-run sleep handling)

Task 3 (loadAgentRunHistory helper)       ────────▶ Task 5 (agent-run resume + transcript persist)

Task 4 ──┐
Task 5 ──┴─▶ Task 6 (SendMessage wake-on-message for sleeping target)
                                                   │
                                                   ▼
                                              Task 7 (verification gate)
```

---

## Task 1: Sleep tool definition

**Files:**
- Create: `src/tools/SleepTool/SleepTool.ts`
- Test: `src/tools/SleepTool/__tests__/SleepTool.test.ts`

The Sleep tool is a thin wrapper. Its execute body:
1. Validates duration_ms is positive and reasonable (max 24h to prevent runaway)
2. Marks `agent_runs.status='sleeping'`, `sleepUntil=now+duration`
3. Calls `enqueueAgentRun({agentId}, {delay: duration_ms})` to schedule wake-up
4. Returns a marker `{ slept: true, agentId, durationMs, wakeAt }` — the agent-run loop sees this and exits early WITHOUT calling synthesizeTaskNotification (the agent isn't done, just yielding)

The `agentId` is read from ToolContext (`callerAgentId` key, injected by agent-run processor).

- [ ] **Step 1: Write the failing test**

Create `src/tools/SleepTool/__tests__/SleepTool.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sleepTool, SLEEP_TOOL_NAME } from '@/tools/SleepTool/SleepTool';

vi.mock('@/lib/queue/agent-run', () => ({
  enqueueAgentRun: vi.fn(async () => ({ id: 'job-1' })),
}));

import { enqueueAgentRun } from '@/lib/queue/agent-run';

function makeAgentCtx(over: { agentId?: string; updateSpy?: ReturnType<typeof vi.fn> } = {}) {
  const updateSpy = over.updateSpy ?? vi.fn();
  return {
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      if (key === 'callerAgentId') return (over.agentId ?? 'agent-self') as V;
      if (key === 'db') {
        return {
          update: vi.fn(() => ({
            set: vi.fn((vals) => ({
              where: vi.fn(async () => updateSpy(vals)),
            })),
          })),
        } as V;
      }
      throw new Error(`missing dep: ${key}`);
    },
  };
}

describe('Sleep tool — Phase D', () => {
  beforeEach(() => {
    vi.mocked(enqueueAgentRun).mockClear();
  });

  it('exports the canonical name "Sleep"', () => {
    expect(SLEEP_TOOL_NAME).toBe('Sleep');
  });

  it('returns slept marker with agentId, durationMs, wakeAt', async () => {
    const result = await sleepTool.execute({ duration_ms: 30_000 }, makeAgentCtx() as never);
    expect(result.slept).toBe(true);
    expect(result.agentId).toBe('agent-self');
    expect(result.durationMs).toBe(30_000);
    expect(result.wakeAt).toBeInstanceOf(Date);
  });

  it('marks agent_runs status=sleeping with sleepUntil', async () => {
    const updateSpy = vi.fn();
    await sleepTool.execute({ duration_ms: 60_000 }, makeAgentCtx({ updateSpy }) as never);
    expect(updateSpy).toHaveBeenCalledOnce();
    expect(updateSpy.mock.calls[0][0]).toMatchObject({
      status: 'sleeping',
      sleepUntil: expect.any(Date),
    });
  });

  it('schedules delayed BullMQ job via enqueueAgentRun', async () => {
    await sleepTool.execute({ duration_ms: 5_000 }, makeAgentCtx({ agentId: 'a-1' }) as never);
    expect(enqueueAgentRun).toHaveBeenCalledOnce();
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      { agentId: 'a-1' },
      expect.objectContaining({ delay: 5_000 }),
    );
  });

  it('rejects duration_ms > 24h (24*3600*1000 = 86_400_000)', async () => {
    await expect(
      sleepTool.execute({ duration_ms: 86_400_001 }, makeAgentCtx() as never),
    ).rejects.toThrow(/24/i);
  });

  it('rejects duration_ms <= 0', async () => {
    await expect(
      sleepTool.execute({ duration_ms: 0 }, makeAgentCtx() as never),
    ).rejects.toThrow(/positive/i);
  });
});
```

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/tools/SleepTool/__tests__/SleepTool.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SleepTool.ts`**

Create `src/tools/SleepTool/SleepTool.ts`:

```ts
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition, ToolContext } from '@/core/types';
import { db as defaultDb, type Database } from '@/lib/db';
import { agentRuns } from '@/lib/db/schema';
import { enqueueAgentRun } from '@/lib/queue/agent-run';

export const SLEEP_TOOL_NAME = 'Sleep';

const MAX_DURATION_MS = 24 * 3600 * 1000; // 24 hours

export const SleepInputSchema = z
  .object({
    duration_ms: z.number().int(),
  })
  .strict();

export type SleepInput = z.infer<typeof SleepInputSchema>;

export interface SleepResult {
  slept: true;
  agentId: string;
  durationMs: number;
  wakeAt: Date;
}

function readDb(ctx: ToolContext): Database {
  try {
    return ctx.get<Database>('db');
  } catch {
    return defaultDb;
  }
}

function readAgentId(ctx: ToolContext): string {
  return ctx.get<string>('callerAgentId');
}

export const sleepTool: ToolDefinition<SleepInput, SleepResult> = buildTool({
  name: SLEEP_TOOL_NAME,
  description:
    'Yield this teammate\'s worker slot for a duration. The transcript is ' +
    'persisted; new SendMessages or sleep expiry will resume the agent. ' +
    'Use when waiting for a peer\'s response or for an external event. ' +
    'Each wake-up costs an API call — do not Sleep for less than ~5 seconds.',
  inputSchema: SleepInputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input, ctx): Promise<SleepResult> {
    if (input.duration_ms <= 0) {
      throw new Error('Sleep: duration_ms must be positive');
    }
    if (input.duration_ms > MAX_DURATION_MS) {
      throw new Error(
        `Sleep: duration_ms ${input.duration_ms} exceeds 24-hour limit (${MAX_DURATION_MS}ms)`,
      );
    }

    const agentId = readAgentId(ctx);
    const db = readDb(ctx);
    const wakeAt = new Date(Date.now() + input.duration_ms);

    // Mark sleeping (the agent-run processor sees the slept marker and
    // exits early — but if the processor crashes between this update and
    // exit, status='sleeping' is the correct fail-safe state)
    await db
      .update(agentRuns)
      .set({
        status: 'sleeping',
        sleepUntil: wakeAt,
        lastActiveAt: new Date(),
      })
      .where(eq(agentRuns.id, agentId));

    // Schedule delayed wake
    await enqueueAgentRun(
      { agentId },
      {
        // BullMQ jobId can collide if a SendMessage wakes us before the
        // delay expires; that's intentional dedup. The earlier wake takes
        // precedence; the delayed job becomes a no-op (agent already
        // running).
        jobId: `sleep:${agentId}:${wakeAt.getTime()}`,
        delay: input.duration_ms,
      },
    );

    return {
      slept: true,
      agentId,
      durationMs: input.duration_ms,
      wakeAt,
    };
  },
});
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm vitest run src/tools/SleepTool/__tests__/SleepTool.test.ts
```

Expected: PASS (6 cases).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/tools/SleepTool/
git commit -m "feat(Sleep): tool definition — yields BullMQ slot + schedules delayed wake (Phase D)"
```

---

## Task 2: Whitelist Sleep + register

**Files:**
- Modify: `src/tools/AgentTool/role-tools.ts` (add SLEEP_TOOL_NAME — but Phase A whitelists are all `'*'`; verify this is still the case and add documentation comment)
- Modify: `src/tools/registry-team.ts` (or registry.ts — register sleepTool)

Per spec: Sleep is allowed for lead + member; explicitly NOT for subagent (subagents must complete in-turn).

In Phase A, all role whitelists contain `'*'` (any tool passes). So technically Sleep is already permitted by layer ②. But Phase D should explicitly track Sleep's role permissions for future tightening. Decision: leave `'*'` whitelists as-is (Phase A invariant), add Sleep to subagent **blacklist** instead — `INTERNAL_SUBAGENT_TOOLS` should include `SLEEP_TOOL_NAME`.

- [ ] **Step 1: Add Sleep to INTERNAL_SUBAGENT_TOOLS**

In `src/tools/AgentTool/blacklists.ts`, find `INTERNAL_SUBAGENT_TOOLS` and add:

```ts
import { SLEEP_TOOL_NAME } from '@/tools/SleepTool/SleepTool';

export const INTERNAL_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  ...INTERNAL_TEAMMATE_TOOLS,
  SEND_MESSAGE_TOOL_NAME,
  SLEEP_TOOL_NAME,  // NEW (Phase D): subagents must complete in-turn, no yield
]);
```

- [ ] **Step 2: Add a test asserting subagent blacklist includes Sleep**

Append to `src/tools/AgentTool/__tests__/blacklists.test.ts`:

```ts
it('subagent additionally cannot Sleep (must complete in-turn)', async () => {
  const { SLEEP_TOOL_NAME } = await import('@/tools/SleepTool/SleepTool');
  expect(INTERNAL_SUBAGENT_TOOLS.has(SLEEP_TOOL_NAME)).toBe(true);
  // And verify lead/member CAN Sleep (not in their blacklist)
  expect(INTERNAL_TEAMMATE_TOOLS.has(SLEEP_TOOL_NAME)).toBe(false);
});
```

- [ ] **Step 3: Register sleepTool in `registry-team.ts`**

```ts
import { sleepTool } from '@/tools/SleepTool/SleepTool';

// In registerDeferredTools or wherever tools are registered:
registry.register(sleepTool);
```

- [ ] **Step 4: Run blacklist tests + verify nothing else breaks**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/blacklists.test.ts
pnpm vitest run src/tools/SleepTool
pnpm tsc --noEmit --pretty false
```

- [ ] **Step 5: Commit**

```bash
git add src/tools/AgentTool/blacklists.ts \
        src/tools/AgentTool/__tests__/blacklists.test.ts \
        src/tools/registry-team.ts
git commit -m "feat(Sleep): add to INTERNAL_SUBAGENT_TOOLS; register tool (Phase D)"
```

---

## Task 3: loadAgentRunHistory helper

**Files:**
- Create: `src/workers/processors/lib/agent-run-history.ts`
- Test: `src/workers/processors/lib/__tests__/agent-run-history.test.ts`

Helper that reads back an agent_runs row's full conversation history from `team_messages` for resume. Returns `Anthropic.Messages.MessageParam[]` ready to pass as `priorMessages` to runAgent.

History inclusion criteria:
- `team_messages` rows where `fromAgentId=agentId` (this agent's outgoing) OR `toAgentId=agentId` (this agent's incoming)
- `deliveredAt IS NOT NULL` (only delivered/processed messages — pending mailbox is drained separately by mailbox-drain helper)
- ORDER BY createdAt ASC (chronological)

Mapping to Anthropic MessageParam:
- `fromAgentId=self, type='agent_text'` → `{role: 'assistant', content: ...}`
- `toAgentId=self, type='user_prompt'` → `{role: 'user', content: ...}`
- (other types like tool_call/tool_result depend on existing team-run patterns — match what `loadConversationHistory` does in `src/lib/team-conversation`)

- [ ] **Step 1: Read existing `loadConversationHistory` for pattern reference**

```bash
cat /Users/yifeng/Documents/Code/shipflare/src/lib/team-conversation.ts | head -100
```

- [ ] **Step 2: Write the failing test**

Create `src/workers/processors/lib/__tests__/agent-run-history.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { loadAgentRunHistory } from '@/workers/processors/lib/agent-run-history';

function makeDb(rows: Array<{
  id: string;
  fromAgentId: string | null;
  toAgentId: string | null;
  type: string;
  messageType: string;
  content: string | null;
  createdAt: Date;
}>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(async () => rows),
        })),
      })),
    })),
  };
}

describe('loadAgentRunHistory', () => {
  it('returns empty array when no history', async () => {
    const db = makeDb([]);
    const result = await loadAgentRunHistory('agent-1', db as never);
    expect(result).toEqual([]);
  });

  it('maps fromAgentId=self user_prompt → assistant role (agent\'s prior turn)', async () => {
    const db = makeDb([
      {
        id: 'm1',
        fromAgentId: 'agent-1',
        toAgentId: null,
        type: 'agent_text',
        messageType: 'message',
        content: 'I drafted 3 replies',
        createdAt: new Date('2026-05-02T00:00:00Z'),
      },
    ]);
    const result = await loadAgentRunHistory('agent-1', db as never);
    expect(result).toEqual([
      { role: 'assistant', content: 'I drafted 3 replies' },
    ]);
  });

  it('maps toAgentId=self user_prompt → user role (incoming message)', async () => {
    const db = makeDb([
      {
        id: 'm1',
        fromAgentId: null,
        toAgentId: 'agent-1',
        type: 'user_prompt',
        messageType: 'message',
        content: 'Continue the work',
        createdAt: new Date('2026-05-02T00:00:00Z'),
      },
    ]);
    const result = await loadAgentRunHistory('agent-1', db as never);
    expect(result).toEqual([
      { role: 'user', content: 'Continue the work' },
    ]);
  });

  it('orders by createdAt ascending', async () => {
    const db = makeDb([
      {
        id: 'm1',
        fromAgentId: null,
        toAgentId: 'agent-1',
        type: 'user_prompt',
        messageType: 'message',
        content: 'first',
        createdAt: new Date('2026-05-02T00:00:00Z'),
      },
      {
        id: 'm2',
        fromAgentId: 'agent-1',
        toAgentId: null,
        type: 'agent_text',
        messageType: 'message',
        content: 'second',
        createdAt: new Date('2026-05-02T00:00:01Z'),
      },
      {
        id: 'm3',
        fromAgentId: null,
        toAgentId: 'agent-1',
        type: 'user_prompt',
        messageType: 'message',
        content: 'third',
        createdAt: new Date('2026-05-02T00:00:02Z'),
      },
    ]);
    const result = await loadAgentRunHistory('agent-1', db as never);
    expect(result.length).toBe(3);
    expect(result[0].content).toBe('first');
    expect(result[1].content).toBe('second');
    expect(result[2].content).toBe('third');
  });

  it('skips rows with null content', async () => {
    const db = makeDb([
      {
        id: 'm1',
        fromAgentId: 'agent-1',
        toAgentId: null,
        type: 'agent_text',
        messageType: 'message',
        content: null,
        createdAt: new Date(),
      },
    ]);
    const result = await loadAgentRunHistory('agent-1', db as never);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 3: Run — verify failure**

- [ ] **Step 4: Implement `agent-run-history.ts`**

```ts
import { and, asc, eq, isNotNull, or } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import { teamMessages } from '@/lib/db/schema';
import type { Database } from '@/lib/db';

interface HistoryRow {
  id: string;
  fromAgentId: string | null;
  toAgentId: string | null;
  type: string;
  messageType: string;
  content: string | null;
  createdAt: Date;
}

/**
 * Load an agent_runs row's prior conversation history for resume.
 * Returns Anthropic MessageParam[] in chronological order.
 *
 * Includes any team_messages row where this agent is sender or recipient
 * AND the row has been delivered (excludes pending mailbox — that's
 * drained separately).
 */
export async function loadAgentRunHistory(
  agentId: string,
  db: Database,
): Promise<Anthropic.Messages.MessageParam[]> {
  const rows = (await db
    .select()
    .from(teamMessages)
    .where(
      and(
        or(
          eq(teamMessages.fromAgentId, agentId),
          eq(teamMessages.toAgentId, agentId),
        ),
        isNotNull(teamMessages.deliveredAt),
      ),
    )
    .orderBy(asc(teamMessages.createdAt))) as unknown as HistoryRow[];

  const messages: Anthropic.Messages.MessageParam[] = [];
  for (const row of rows) {
    if (row.content === null) continue;
    const role: 'user' | 'assistant' =
      row.fromAgentId === agentId ? 'assistant' : 'user';
    messages.push({ role, content: row.content });
  }
  return messages;
}
```

- [ ] **Step 5: Run — verify pass**

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/workers/processors/lib/agent-run-history.ts \
        src/workers/processors/lib/__tests__/agent-run-history.test.ts
git commit -m "feat(workers/lib): loadAgentRunHistory — read prior transcript for resume (Phase D)"
```

---

## Task 4: agent-run handles Sleep tool's special return + status sleeping

**Files:**
- Modify: `src/workers/processors/agent-run.ts` (detect Sleep return; exit early without notification)
- Test: `src/workers/processors/__tests__/agent-run.test.ts` (extend)

When the Sleep tool returns `{slept: true, ...}`, the runAgent loop should exit gracefully WITHOUT calling `synthAndDeliverNotification` (the agent isn't done — it's just yielding).

Detection mechanism: subscribe to runAgent's `onEvent` callback (passed as positional arg 9 per the existing pattern). Watch for `tool_result` events where `tool_name === 'Sleep'` and `result.slept === true`. Set a `sleepingExit` flag; abort the controller; in the catch block, check `sleepingExit` and skip notification.

- [ ] **Step 1: Add failing tests**

Append to `src/workers/processors/__tests__/agent-run.test.ts`:

```ts
it('Sleep tool return triggers early exit WITHOUT calling synthesizeTaskNotification', async () => {
  // Mock runAgent to call onEvent with a Sleep tool_result, then return cleanly
  vi.mocked(runAgent).mockImplementation(async (...args) => {
    const onEvent = args[8]; // positional arg
    if (onEvent) {
      await onEvent({
        type: 'tool_result',
        tool_name: 'Sleep',
        result: { slept: true, agentId: 'agent-1', durationMs: 30000, wakeAt: new Date() },
      });
    }
    return { result: '', usage: { totalTokens: 0, toolUses: 1, durationMs: 1, costUsd: 0 } };
  });
  // ... agent-run setup ...
  await processAgentRun(makeJob('agent-1'));
  // Assert: agent_runs status was set to 'sleeping' by Sleep tool itself,
  // NOT to 'completed' by agent-run.
  // Assert: synthesize-notification was NOT called.
  expect(synthesizeSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Modify agent-run.ts to detect Sleep**

In `src/workers/processors/agent-run.ts`, in the `processAgentRun` function:

```ts
let sleepingExit = false;

// Wrap the existing onEvent (or add one) to detect Sleep tool_result
const detectSleep = async (event: unknown) => {
  if (event && typeof event === 'object' && 'type' in event && event.type === 'tool_result') {
    const evt = event as { tool_name?: string; result?: unknown };
    if (evt.tool_name === 'Sleep' && evt.result && typeof evt.result === 'object' && 'slept' in evt.result) {
      sleepingExit = true;
      controller.abort(); // signal runAgent to exit at next safe point
    }
  }
  // Forward to original onEvent if present
  // ...
};

// ... runAgent call passes detectSleep as onEvent ...

// On exit, BEFORE the synthAndDeliverNotification call:
if (sleepingExit) {
  // Sleep tool already updated agent_runs.status='sleeping' and scheduled
  // the wake. Just clear the worker slot and return.
  log.info('agent-run yielded for sleep', { agentId });
  return;
}

// ... existing notification logic ...
```

- [ ] **Step 3: Run agent-run tests — verify pass**

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/workers/processors/agent-run.ts \
        src/workers/processors/__tests__/agent-run.test.ts
git commit -m "feat(agent-run): detect Sleep tool — early exit without notification (Phase D)"
```

---

## Task 5: agent-run resume from history

**Files:**
- Modify: `src/workers/processors/agent-run.ts` (add resume path: if status='sleeping' or 'queued' with prior transcript, load history)
- Test: `src/workers/processors/__tests__/agent-run.test.ts` (extend)

When agent-run starts and finds `agent_runs.status === 'sleeping'`, this is a resume. Before calling runAgent:
1. Mark status='resuming' (transitional state)
2. Load history via `loadAgentRunHistory(agentId, db)`
3. Pass as `priorMessages` to runAgent (positional arg 10 per existing pattern)
4. Mark status='running'

Also: every assistant turn should be persisted as it happens — wrap onEvent to insert team_messages rows for each assistant message. This way resume sees full prior turns.

- [ ] **Step 1: Add failing tests**

```ts
it('on resume from sleeping, loads history and passes as priorMessages', async () => {
  vi.mocked(loadAgentRunHistory).mockResolvedValue([
    { role: 'user', content: 'initial prompt' },
    { role: 'assistant', content: 'I will help' },
  ]);
  // mock agent_runs row with status='sleeping'
  await processAgentRun(makeJob('agent-1'));
  // assert: status went sleeping → resuming → running
  // assert: runAgent was called with priorMessages = the 2 history items
  const runAgentCall = vi.mocked(runAgent).mock.calls[0];
  expect(runAgentCall[9]).toEqual([
    { role: 'user', content: 'initial prompt' },
    { role: 'assistant', content: 'I will help' },
  ]);
});

it('persists each assistant turn to team_messages so resume sees full history', async () => {
  vi.mocked(runAgent).mockImplementation(async (...args) => {
    const onEvent = args[8];
    if (onEvent) {
      await onEvent({ type: 'assistant_message', content: 'turn 1' });
      await onEvent({ type: 'assistant_message', content: 'turn 2' });
    }
    return { result: 'done', usage: ... };
  });
  await processAgentRun(makeJob('agent-1'));
  // assert: 2 inserts to team_messages (one per assistant turn) with fromAgentId=self
  expect(insertSpy).toHaveBeenCalledTimes(3); // 2 assistant turns + 1 final task_notification
});
```

- [ ] **Step 2: Implement resume path in agent-run.ts**

```ts
import { loadAgentRunHistory } from './lib/agent-run-history';

// ... in processAgentRun, after loading the agent_runs row ...

let priorMessages: Anthropic.Messages.MessageParam[] = [];
if (row.status === 'sleeping') {
  await db.update(agentRuns).set({ status: 'resuming' }).where(eq(agentRuns.id, agentId));
  priorMessages = await loadAgentRunHistory(agentId, db);
  log.info('resuming from sleep', { agentId, priorTurns: priorMessages.length });
}

await db.update(agentRuns).set({ status: 'running', lastActiveAt: new Date() }).where(eq(agentRuns.id, agentId));

// ... existing initial prompt logic + drainMailbox ...

// Wrap onEvent to persist assistant turns
const persistAndDetect = async (event: unknown) => {
  if (event && typeof event === 'object' && 'type' in event) {
    if (event.type === 'assistant_message' && 'content' in event && typeof event.content === 'string') {
      // Persist to team_messages so resume sees this turn
      await db.insert(teamMessages).values({
        teamId: row.teamId,
        type: 'agent_text',
        messageType: 'message',
        fromMemberId: row.memberId,
        fromAgentId: agentId,
        content: event.content,
        deliveredAt: new Date(), // mark immediately so loadHistory sees it
      });
    }
    if (event.type === 'tool_result' && 'tool_name' in event && event.tool_name === 'Sleep') {
      sleepingExit = true;
      controller.abort();
    }
  }
};

const result = await runAgent(
  config,
  initialPrompt,
  ctx,
  undefined,
  undefined,
  undefined,
  undefined,
  persistAndDetect,  // arg 8: onEvent
  undefined,         // arg 9: injectMessages (Phase C added drain timer instead)
  priorMessages,     // arg 10: priorMessages
);
```

- [ ] **Step 3: Run tests — verify pass**

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/workers/processors/agent-run.ts \
        src/workers/processors/__tests__/agent-run.test.ts
git commit -m "feat(agent-run): resume from sleeping with priorMessages + persist turns (Phase D)"
```

---

## Task 6: SendMessage wakes sleeping recipient on `message` variant

**Files:**
- Modify: `src/tools/SendMessageTool/SendMessageTool.ts` (in dispatchMessage, check recipient status; if sleeping, call wake())

Currently only `shutdown_request` and `plan_approval_response` wake the recipient. Phase D extends `message` variant to wake too — when target is sleeping. (Don't wake if already running; wake is idempotent via jobId dedup but extra work.)

- [ ] **Step 1: Add failing test**

```ts
it('type:message wakes recipient if their agent_runs.status is sleeping', async () => {
  // mock the recipient lookup to return status='sleeping' for some agent_runs
  // then SendMessage type:message → assert wake() was called
  await sendMessageTool.execute(
    { type: 'message', to: 'sleeping-agent', content: 'wake up' },
    teammateCtx,
  );
  expect(wakeSpy).toHaveBeenCalledWith(expect.stringContaining('sleeping'));
});

it('type:message does NOT wake recipient if status is running', async () => {
  // mock recipient status='running'
  await sendMessageTool.execute(
    { type: 'message', to: 'running-agent', content: 'hi' },
    teammateCtx,
  );
  expect(wakeSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Modify dispatchMessage**

```ts
import { agentRuns } from '@/lib/db/schema';

async function dispatchMessage(input, deps) {
  // ... existing primary insert + peer-DM shadow ...
  
  // Phase D: if recipient is a sleeping agent_runs row, wake it.
  // Phase B-C: only resolves member id; Phase E will resolve to agent_runs.id directly.
  // For now, look up agent_runs WHERE memberId=toMemberId AND status IN ('sleeping')
  // and wake if found.
  const sleeping = await deps.db.select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(
      eq(agentRuns.memberId, toMemberId),
      eq(agentRuns.status, 'sleeping'),
    ))
    .limit(1);
  if (sleeping.length > 0) {
    await wake(sleeping[0].id);
  }
  
  return { delivered: true, messageId, toMemberId };
}
```

- [ ] **Step 3: Run tests — verify pass**

- [ ] **Step 4: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/tools/SendMessageTool/SendMessageTool.ts \
        src/tools/SendMessageTool/__tests__/SendMessageTool.test.ts
git commit -m "feat(SendMessage): wake recipient on type:message when sleeping (Phase D)"
```

---

## Task 7: Verification gate

- [ ] **Step 1: Run full Phase D tests**

```bash
pnpm vitest run src/tools/SleepTool \
                src/workers/processors/lib/__tests__/agent-run-history.test.ts \
                src/workers/processors/__tests__/agent-run.test.ts \
                src/tools/SendMessageTool
```

Expected: all PASS.

- [ ] **Step 2: Phase A + B + C regression**

```bash
pnpm vitest run src/tools/AgentTool src/lib/feature-flags src/workers/processors/lib src/tools/TaskStopTool
```

Expected: no regression.

- [ ] **Step 3: Full repo sweep**

```bash
pnpm test 2>&1 | tail -40
```

Expected: 910+ pass.

- [ ] **Step 4: Typecheck**

```bash
pnpm tsc --noEmit --pretty false
```

- [ ] **Step 5: Tag**

```bash
git tag -a phase-d-sleep-resume -m "Agent Teams Phase D — Sleep + Resume complete"
```

- [ ] **Step 6: Update spec doc**

Append to `## Implementation status`:

```markdown
- **Phase D — Sleep + Resume:** landed `2026-05-02` on `dev`. Sleep tool yields
  the BullMQ worker slot mid-conversation; agent-run processor handles
  sleeping → resuming → running transitions; loadAgentRunHistory rebuilds
  the conversation from team_messages on resume. SendMessage type:message
  now wakes sleeping recipients (was: only shutdown_request woke in Phase C).
  Each assistant turn is persisted to team_messages during runAgent so
  resume sees full prior history.
  - Task 1 — Sleep tool: <SHA>
  - Task 2 — whitelist + register: <SHA>
  - Task 3 — loadAgentRunHistory: <SHA>
  - Task 4 — agent-run Sleep early-exit: <SHA>
  - Task 5 — agent-run resume + persist: <SHA>
  - Task 6 — SendMessage wakes sleeping recipient: <SHA>
  - Task 7 — verification gate: <SHA>
```

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md
git commit -m "docs(spec): mark Agent Teams Phase D landed"
```

---

## Acceptance criteria

- [ ] Sleep tool exists with proper validation (positive duration, max 24h)
- [ ] Sleep marks agent_runs.status='sleeping' + sleepUntil
- [ ] Sleep schedules delayed BullMQ wake via enqueueAgentRun({delay})
- [ ] SLEEP_TOOL_NAME in INTERNAL_SUBAGENT_TOOLS (subagents can't Sleep)
- [ ] sleepTool registered in registry
- [ ] loadAgentRunHistory returns chronologically-ordered MessageParam[]
- [ ] Maps fromAgentId=self → assistant role; toAgentId=self → user role
- [ ] agent-run detects Sleep tool result → exits early without notification
- [ ] agent-run on status='sleeping' resume: loads history → status='resuming' → status='running' → runAgent with priorMessages
- [ ] Each assistant turn persisted to team_messages during runAgent
- [ ] SendMessage type:message wakes sleeping recipient
- [ ] All Phase A/B/C tests still green; Phase D tests green
- [ ] tsc clean
- [ ] Local tag `phase-d-sleep-resume`
- [ ] Spec doc has Phase D landed timestamp + 7 commit SHAs

---

## Self-review notes

1. **Spec coverage**: every Phase D row in spec §6 maps to a task above.
2. **Assistant-turn persistence in Task 5** is the load-bearing detail. Without it, resume sees only the initial prompt + drained mailbox messages — NOT the agent's prior reasoning. Must persist via onEvent hook.
3. **The `tool_result` event shape** for Sleep detection (Task 4) depends on runAgent's actual onEvent callback signature. If the actual shape differs, adjust the detector accordingly. Look at how Phase C Task 7 (`7d7e1e0`) detects shutdown_request through the drain — similar pattern.
4. **Wake-on-message in Task 6** uses an additional DB query per message send (check if recipient sleeping). For Phase D MVP this is acceptable; Phase E may optimize by maintaining recipient status in a faster lookup.
5. **Race conditions to watch**: SendMessage triggers wake while Sleep delay also fires — BullMQ jobId dedup handles this (the second enqueue is a no-op if the first job is already running). Test 4 of Task 1 verifies the unique jobId pattern.
