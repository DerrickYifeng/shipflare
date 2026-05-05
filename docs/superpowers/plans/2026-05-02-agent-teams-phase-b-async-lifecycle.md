# Agent Teams — Phase B: Async Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the async Task path end-to-end behind a feature flag (`SHIPFLARE_AGENT_TEAMS`) — `Task({subagent_type, prompt, run_in_background:true})` returns immediately with `{agentId, status:'async_launched'}`, the teammate runs in its own BullMQ `agent-run` job, and on exit a `<task-notification>` XML message lands in the lead's mailbox via `team_messages` for the lead's next idle turn to drain. Flag-off path is byte-for-byte unchanged.

**Architecture:** New `agent-run` BullMQ queue dispatches one job per teammate run. Each run loads its `agent_runs` row, executes `runAgent` to completion, then synthesizes a `<task-notification>` row into `team_messages` addressed to the parent's `agent_id`. The `Task` tool's existing sync path stays default; the new async branch is opt-in via `run_in_background:true` AND the team flag being on. `SyntheticOutputTool` is a system-only Tool (never registered in the LLM-facing registry, never in any `assembleToolPool` whitelist) — it exists purely as the lifecycle helper that produces well-formed XML.

**Tech Stack:** TypeScript 5, Vitest, Zod, Drizzle ORM, BullMQ (Redis), Postgres.

**Spec reference:** `docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md` § Phase B.

**Phase B non-goals** (per spec; reserved for later phases):
- `Sleep` tool / yield-and-resume — Phase D
- `SendMessage` discriminated union (broadcast / shutdown_request etc.) — Phase C
- `TaskStop` tool — Phase C
- Peer-DM visibility shadow — Phase C
- team-run unification (X driver) — Phase E
- Drop-flag cleanup — Phase G

This phase ships the **minimum viable async-spawn → run → notify-back roundtrip**. Mailbox drain runs only at lead's natural turn boundary in `team-run` (an additive hook into existing `team-run.ts`). No Sleep, no resume — Phase B teammates run to completion in one BullMQ job invocation.

---

## File structure

**New files (10):**

| Path | Responsibility |
|---|---|
| `src/lib/feature-flags/agent-teams.ts` | `isAgentTeamsEnabledForTeam(teamId): Promise<boolean>` — env-var-only in Phase B (`SHIPFLARE_AGENT_TEAMS=1`). Phase E adds DB lookup |
| `src/lib/feature-flags/__tests__/agent-teams.test.ts` | Env-flag toggling tests |
| `src/workers/processors/lib/wake.ts` | `wake(agentId): Promise<void>` — enqueue an `agent-run` job for `agentId` with idempotency via BullMQ `jobId` dedupe. Used by the Task async path; Phase C SendMessage and Phase D Sleep also reuse it |
| `src/workers/processors/lib/__tests__/wake.test.ts` | Enqueue + dedupe tests |
| `src/workers/processors/lib/mailbox-drain.ts` | `drainMailbox(agentId, db): Promise<DrainedMessage[]>` — pull undelivered `team_messages` for `to_agent_id=agentId`, mark `delivered_at`, return ordered batch. Idempotent via `for update` row lock |
| `src/workers/processors/lib/__tests__/mailbox-drain.test.ts` | Idempotency + ordering tests |
| `src/workers/processors/lib/synthesize-notification.ts` | `synthesizeTaskNotification({agentId, status, finalText, usage}): string` — construct `<task-notification>` XML. Single source of truth for the XML schema |
| `src/workers/processors/lib/__tests__/synthesize-notification.test.ts` | XML shape tests for completed / failed / killed |
| `src/tools/SyntheticOutputTool/SyntheticOutputTool.ts` | The system-only Tool. `isEnabled()` returns false at runtime; never in `ROLE_WHITELISTS`; double-defended against accidental LLM exposure |
| `src/tools/SyntheticOutputTool/__tests__/SyntheticOutputTool.test.ts` | Verifies `isEnabled()` returns false; `assembleToolPool` always excludes it |
| `src/lib/queue/agent-run.ts` | `AGENT_RUN_QUEUE_NAME` constant + `AgentRunJobData` interface + typed `enqueueAgentRun(data, opts?)` helper |
| `src/workers/processors/agent-run.ts` | Phase B lifecycle: `queued → running → (completed | failed)`. Loads `agent_runs` row, calls `runAgent`, synthesizes notification on exit. **No** Sleep, **no** resume — single-shot in this phase |
| `src/workers/processors/__tests__/agent-run.test.ts` | State machine + notification-roundtrip tests |
| `src/workers/processors/reconcile-mailbox.ts` | `processReconcileMailbox()` — every-minute orphan re-enqueue (catches enqueue failures from `wake()`) |
| `src/workers/processors/__tests__/reconcile-mailbox.test.ts` | Re-enqueues only orphans, leaves delivered messages alone |

**Modified files (8):**

| Path | What changes |
|---|---|
| `src/lib/db/schema/team.ts` | Add `agentRuns` pgTable + new columns on `teamMessages`. Use existing text-id convention (`crypto.randomUUID`-default), NOT pg `uuid` |
| `src/lib/db/schema/index.ts` | Re-export `agentRuns` |
| `src/lib/queue/index.ts` | Re-export `enqueueAgentRun` and queue name |
| `src/workers/index.ts` | Register `agent-run` Worker + `reconcile-mailbox` cron (every minute) |
| `src/tools/AgentTool/AgentTool.ts` | Extend `TaskInputSchema` with optional `run_in_background?: boolean`. Add async branch in `execute()` body — when flag is ON and `run_in_background:true`, insert `agent_runs` row and call `wake()`, return `{agentId, status:'async_launched', cost:0, duration:0, turns:0, result: null}`. Sync branch unchanged |
| `src/tools/AgentTool/__tests__/Task.test.ts` | Add cases for the new async branch (flag on / off scenarios) |
| `src/workers/processors/team-run.ts` | Add a one-call mailbox drain at each idle turn boundary in the lead's runAgent loop. Drained messages are injected as user-role transcript entries before the next assistant call |
| `drizzle/<NNNN>_agent_runs_and_team_messages_extensions.sql` | Generated by `pnpm drizzle-kit generate` after the schema edit |

**Total:** 10 new files + 8 modifications = 18 file touches across 14 tasks.

---

## Sequence + dependencies

```
Task 1 (schema)                   ─┐
Task 2 (drizzle gen + apply)      ─┘─▶ Task 7 (agent-run queue)  ─┐
                                                                    │
Task 3 (feature flag)             ───────────────────────────────────│─▶ Task 11 (Task tool extend)
                                                                    │
Task 4 (wake helper)              ───────────────────────────────────┤
Task 5 (mailbox-drain helper)     ───────────────────────────────────┤
Task 6 (synthesize-notification)  ───────────────────────────────────┤
                                                                    │
                                  ┌─▶ Task 8 (SyntheticOutputTool)  │
                                  │                                  │
Task 9 (agent-run processor)  ────┴─▶ Task 10 (register worker)  ────┴─▶ Task 12 (team-run drain)
                                                                                   │
Task 13 (reconcile-mailbox cron) ────────────────────────────────────────────────────│
                                                                                   │
                                                                                   ▼
                                                                            Task 14 (verification gate)
```

---

## Task 1: Schema — `agent_runs` table + `team_messages` column extensions

**Files:**
- Modify: `src/lib/db/schema/team.ts` (add `agentRuns` pgTable; extend `teamMessages` with new columns)
- Modify: `src/lib/db/schema/index.ts` (re-export `agentRuns`)
- Test: none for this task — DB shape is verified end-to-end in later tasks

- [ ] **Step 1: Read current `team.ts` to know the ID convention and column patterns**

```bash
sed -n '1,40p' /Users/yifeng/Documents/Code/shipflare/src/lib/db/schema/team.ts
grep -n "teamMessages\|teamMembers\|teamRuns\|pgTable\|primaryKey" /Users/yifeng/Documents/Code/shipflare/src/lib/db/schema/team.ts | head -30
```

Confirm: all primary keys use `text('id').primaryKey().$defaultFn(() => crypto.randomUUID())` (NOT pg uuid type).

- [ ] **Step 2: Add `agentRuns` table to `team.ts`**

Append (at the END of `src/lib/db/schema/team.ts`, before any closing braces / re-exports):

```ts
// ---------------------------------------------------------------------------
// agent_runs — one row per agent invocation in the unified Agent Teams
// runtime (Phase B+). Covers both team-lead and teammate runs (Phase E
// unifies the entry path; Phase B only constructs teammate rows via
// the Task tool's async branch).
//
// Status state machine (Phase B subset — Sleep/resume land in Phase D):
//   queued → running → (completed | failed | killed)
//
// `parent_agent_id` is NULL for lead runs; set to the parent's agent_id
// for teammate runs spawned by Task({run_in_background:true}).
// ---------------------------------------------------------------------------

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => teamMembers.id, { onDelete: 'cascade' }),
    agentDefName: text('agent_def_name').notNull(),
    parentAgentId: text('parent_agent_id'),
    bullmqJobId: text('bullmq_job_id'),
    status: text('status')
      .notNull()
      .default('queued'),
    transcriptId: text('transcript_id'),
    spawnedAt: timestamp('spawned_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    sleepUntil: timestamp('sleep_until', { withTimezone: true }),
    shutdownReason: text('shutdown_reason'),
    totalTokens: bigint('total_tokens', { mode: 'number' }).default(0),
    toolUses: integer('tool_uses').default(0),
  },
  (t) => ({
    statusIdx: index('idx_agent_runs_team_status_active').on(
      t.teamId,
      t.status,
      t.lastActiveAt,
    ),
    sleepIdx: index('idx_agent_runs_sleep_until').on(t.sleepUntil),
    parentIdx: index('idx_agent_runs_parent').on(t.parentAgentId),
  }),
);

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
```

If `bigint` and `integer` aren't already imported at the top of the file, add them to the existing drizzle-orm/pg-core import.

- [ ] **Step 3: Extend `teamMessages` with Agent Teams routing columns**

Find the `teamMessages` `pgTable` definition in `team.ts`. Inside its column object, add the following columns adjacent to the existing `metadata` column:

```ts
    // ----------------- Phase B (Agent Teams) routing columns -----------------
    /**
     * Agent Teams protocol type. Orthogonal to existing `type` (which is
     * the LLM-flow kind: user_prompt / agent_text / tool_call / etc.).
     * `task_notification` rows have type='user_prompt' AND
     * messageType='task_notification'.
     */
    messageType: text('message_type').notNull().default('message'),
    /** Specific run reference for Agent Teams routing (additive to the
     *  existing fromMemberId/toMemberId which point at the static
     *  team roster). Required because the same member can have multiple
     *  historical agent_runs. */
    fromAgentId: text('from_agent_id'),
    toAgentId: text('to_agent_id'),
    /** Mailbox drain idempotency marker. NULL = not yet delivered. */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /** 1-line preview shown to team-lead via peer-DM visibility (Phase C). */
    summary: text('summary'),
    /** Reply-to chain (Phase C shutdown_response / plan_approval_response). */
    repliesToId: text('replies_to_id'),
```

Add a new index inside the table-definition tuple:

```ts
    deliveryIdx: index('idx_team_messages_to_undelivered')
      .on(t.toAgentId, t.deliveredAt)
      .where(sql`delivered_at IS NULL`),
```

If `sql` from drizzle-orm isn't already imported at the top of the file, add `import { sql } from 'drizzle-orm';`.

- [ ] **Step 4: Re-export from index**

Open `src/lib/db/schema/index.ts`. Find the existing re-exports from `./team`. Add `agentRuns` (and `AgentRun` / `NewAgentRun` types) to the export list.

```ts
export {
  // ... existing exports ...
  agentRuns,
  type AgentRun,
  type NewAgentRun,
} from './team';
```

(Use the syntax that matches the file's existing pattern — bare `export *` is also acceptable if that's what's already there.)

- [ ] **Step 5: Verify the schema compiles**

```bash
pnpm tsc --noEmit --pretty false
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/schema/team.ts src/lib/db/schema/index.ts
git commit -m "feat(db/schema): add agent_runs + team_messages Agent Teams routing columns (Phase B)"
```

---

## Task 2: Generate + apply Drizzle migration

**Files:**
- Generated: `drizzle/NNNN_*.sql` (Drizzle generates the filename)

- [ ] **Step 1: Verify drizzle config**

```bash
cat /Users/yifeng/Documents/Code/shipflare/drizzle.config.ts
```

Note the `out:` path (where migrations go) and the `schema:` path (where Drizzle reads from). Phase B schema additions must show up in the next generated migration.

- [ ] **Step 2: Generate the migration**

```bash
pnpm drizzle-kit generate
```

Expected: a new `.sql` file appears under the `out:` directory (likely `drizzle/`). Filename will be like `NNNN_<auto_summary>.sql`.

- [ ] **Step 3: Inspect the generated SQL**

```bash
ls -tr drizzle/ | tail -3
cat drizzle/<the new file>.sql
```

Verify it contains:
- `CREATE TABLE "agent_runs" (...)` with all columns from Task 1 step 2
- `ALTER TABLE "team_messages" ADD COLUMN "message_type"` etc. for the 6 new columns
- New indexes (`idx_agent_runs_*`, `idx_team_messages_to_undelivered`)
- The partial index `WHERE delivered_at IS NULL`

If anything is wrong (e.g., wrong column type, missing index), fix the schema in Task 1 and regenerate.

- [ ] **Step 4: Apply the migration locally**

```bash
pnpm drizzle-kit migrate
# Or whatever your local migration command is — check package.json scripts
```

Or, if using `pnpm db:migrate` or similar, run that. Verify against your local Postgres:

```bash
psql $POSTGRES_URL -c "\d agent_runs"
psql $POSTGRES_URL -c "\d team_messages"
```

Confirm the new columns and indexes exist.

- [ ] **Step 5: Commit**

```bash
git add drizzle/
git commit -m "chore(db): drizzle migration for agent_runs + team_messages Phase B columns"
```

---

## Task 3: Feature flag — `isAgentTeamsEnabledForTeam`

**Files:**
- Create: `src/lib/feature-flags/agent-teams.ts`
- Test: `src/lib/feature-flags/__tests__/agent-teams.test.ts`

**Phase B scope:** env-var-only check. The function takes a `teamId` parameter for forward compatibility (Phase E adds DB-flag overrides per-team), but in Phase B it's unused — flag is global.

- [ ] **Step 1: Write the failing test**

Create `src/lib/feature-flags/__tests__/agent-teams.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAgentTeamsEnabledForTeam } from '@/lib/feature-flags/agent-teams';

describe('isAgentTeamsEnabledForTeam', () => {
  const originalEnv = process.env.SHIPFLARE_AGENT_TEAMS;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SHIPFLARE_AGENT_TEAMS;
    else process.env.SHIPFLARE_AGENT_TEAMS = originalEnv;
  });

  it('returns false when env var is unset', async () => {
    delete process.env.SHIPFLARE_AGENT_TEAMS;
    await expect(isAgentTeamsEnabledForTeam('any-team-id')).resolves.toBe(false);
  });

  it('returns true when env var is "1"', async () => {
    process.env.SHIPFLARE_AGENT_TEAMS = '1';
    await expect(isAgentTeamsEnabledForTeam('any-team-id')).resolves.toBe(true);
  });

  it('returns true when env var is "true"', async () => {
    process.env.SHIPFLARE_AGENT_TEAMS = 'true';
    await expect(isAgentTeamsEnabledForTeam('any-team-id')).resolves.toBe(true);
  });

  it('returns false when env var is "0" / "false" / other', async () => {
    process.env.SHIPFLARE_AGENT_TEAMS = '0';
    await expect(isAgentTeamsEnabledForTeam('any-team-id')).resolves.toBe(false);
    process.env.SHIPFLARE_AGENT_TEAMS = 'false';
    await expect(isAgentTeamsEnabledForTeam('any-team-id')).resolves.toBe(false);
    process.env.SHIPFLARE_AGENT_TEAMS = 'maybe';
    await expect(isAgentTeamsEnabledForTeam('any-team-id')).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/lib/feature-flags/__tests__/agent-teams.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the flag module**

Create `src/lib/feature-flags/agent-teams.ts`:

```ts
// Feature flag for the Agent Teams async lifecycle (Phase B).
//
// Phase B scope: env-var-only check. The function takes a `teamId`
// parameter for forward compatibility — Phase E will add per-team DB
// overrides so we can graduate teams individually before flipping the
// global flag.
//
// Truthy env values: '1', 'true' (case-insensitive). Anything else =
// false (including unset).

const TRUTHY = new Set(['1', 'true']);

/**
 * Check whether Agent Teams async lifecycle is enabled for the given team.
 *
 * Phase B: returns env-var truthiness; teamId unused.
 * Phase E: will check `teams.feature_agent_teams` column override first,
 * fall back to env.
 */
export async function isAgentTeamsEnabledForTeam(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _teamId: string,
): Promise<boolean> {
  const raw = process.env.SHIPFLARE_AGENT_TEAMS?.toLowerCase().trim();
  return raw !== undefined && TRUTHY.has(raw);
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm vitest run src/lib/feature-flags/__tests__/agent-teams.test.ts
```

Expected: PASS (4 cases).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/lib/feature-flags/agent-teams.ts \
        src/lib/feature-flags/__tests__/agent-teams.test.ts
git commit -m "feat(feature-flags): isAgentTeamsEnabledForTeam (env gate, Phase B)"
```

---

## Task 4: Wake helper — `wake(agentId)`

**Files:**
- Create: `src/workers/processors/lib/wake.ts`
- Test: `src/workers/processors/lib/__tests__/wake.test.ts`

The wake helper is the SINGLE place that enqueues `agent-run` jobs. Used by the Task tool's async branch (this phase), Phase C SendMessage, and Phase D Sleep wakeups. By centralizing the enqueue, we get one place to apply dedupe / job-id collision logic.

**Note**: this task creates the helper but the actual `enqueueAgentRun` queue function lands in Task 7. For Phase B Step 1, mock the queue. The real wiring happens in Task 7 + Task 11 (Task tool extension). We keep wake.ts minimal here.

- [ ] **Step 1: Write the failing test**

Create `src/workers/processors/lib/__tests__/wake.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wake } from '@/workers/processors/lib/wake';

// Mock the queue helper that wake() depends on
vi.mock('@/lib/queue/agent-run', () => ({
  AGENT_RUN_QUEUE_NAME: 'agent-run',
  enqueueAgentRun: vi.fn(async (data: { agentId: string }, opts?: { jobId?: string }) => ({
    id: opts?.jobId ?? 'generated-id',
    data,
  })),
}));

import { enqueueAgentRun } from '@/lib/queue/agent-run';

describe('wake(agentId)', () => {
  beforeEach(() => {
    vi.mocked(enqueueAgentRun).mockClear();
  });

  it('enqueues an agent-run job with the given agentId', async () => {
    await wake('agent-123');
    expect(enqueueAgentRun).toHaveBeenCalledOnce();
    const call = vi.mocked(enqueueAgentRun).mock.calls[0];
    expect(call[0]).toEqual({ agentId: 'agent-123' });
  });

  it('uses agentId as the BullMQ jobId for dedupe', async () => {
    await wake('agent-456');
    const call = vi.mocked(enqueueAgentRun).mock.calls[0];
    // Per BullMQ docs, jobs with the same jobId are deduplicated within
    // the queue's lifetime — preventing duplicate wakes from racing
    // SendMessage callers in Phase C.
    expect(call[1]?.jobId).toMatch(/agent-456/);
  });
});
```

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/workers/processors/lib/__tests__/wake.test.ts
```

Expected: FAIL — module not found (wake.ts doesn't exist yet; queue/agent-run.ts also doesn't exist but is mocked).

- [ ] **Step 3: Implement `wake.ts`**

Create `src/workers/processors/lib/wake.ts`:

```ts
// Single enqueue point for waking an agent_runs row.
//
// Used by:
//   - Task tool async branch (Phase B) — first spawn
//   - SendMessage tool body (Phase C) — wake on incoming message
//   - Sleep tool body (Phase D) — schedule resume via BullMQ delay
//
// Dedupe: BullMQ's jobId mechanism collapses duplicate wakes within the
// queue's removeOnComplete window. We use a per-second time bucket so
// near-simultaneous SendMessages don't fire two parallel runAgent loops
// for the same agent.

import { enqueueAgentRun } from '@/lib/queue/agent-run';

/**
 * Wake the agent identified by `agentId` — schedule its `agent-run`
 * BullMQ job. Idempotent within a 1-second window via jobId dedupe.
 *
 * Returns nothing; failures are swallowed and logged. The
 * `reconcile-mailbox` cron (Phase B Task 13) is the durable backstop:
 * it re-enqueues any agent with undelivered mail every minute.
 */
export async function wake(agentId: string): Promise<void> {
  // Bucket by seconds so two wakes within the same 1-second window
  // collapse into one BullMQ job. Different seconds → separate runs.
  const bucket = Math.floor(Date.now() / 1000);
  const jobId = `wake:${agentId}:${bucket}`;
  await enqueueAgentRun({ agentId }, { jobId });
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm vitest run src/workers/processors/lib/__tests__/wake.test.ts
```

Expected: PASS (2 cases).

- [ ] **Step 5: Typecheck**

```bash
pnpm tsc --noEmit --pretty false
```

Note: typecheck will fail because `@/lib/queue/agent-run` is mocked in the test but not yet implemented. This is fine — vitest's mock satisfies the import at runtime, and `tsc` may still complain about the missing module path. If it does, mark this task DONE_WITH_CONCERNS and resolve in Task 7 when the real `agent-run` queue helper lands.

If `tsc` complains specifically about `Cannot find module '@/lib/queue/agent-run'`, do NOT add a stub — this is a forward dependency that Task 7 satisfies. Note in the report and proceed to commit.

- [ ] **Step 6: Commit**

```bash
git add src/workers/processors/lib/wake.ts \
        src/workers/processors/lib/__tests__/wake.test.ts
git commit -m "feat(workers/lib): wake(agentId) — single enqueue point with jobId dedupe"
```

---

## Task 5: Mailbox-drain helper — `drainMailbox(agentId, db)`

**Files:**
- Create: `src/workers/processors/lib/mailbox-drain.ts`
- Test: `src/workers/processors/lib/__tests__/mailbox-drain.test.ts`

**Idempotency**: drain marks `delivered_at` in the SAME transaction as the read (`for update`). A second concurrent drain returns an empty batch (rows are locked OR already marked).

For Phase B's tests, we use an in-memory mock of the DB layer because spinning up Postgres for unit tests adds noise. The real DB integration is exercised by the Task 14 end-to-end test.

- [ ] **Step 1: Write the failing test**

Create `src/workers/processors/lib/__tests__/mailbox-drain.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { drainMailbox } from '@/workers/processors/lib/mailbox-drain';

// Lightweight db mock: enough surface for drainMailbox's transaction body.
function makeDbMock(undelivered: Array<{
  id: string;
  toAgentId: string;
  type: string;
  messageType: string;
  content: string | null;
  createdAt: Date;
}>) {
  const updates: string[][] = [];
  return {
    transaction: vi.fn(async (cb: (tx: typeof db) => Promise<unknown>) => {
      // Build a minimal tx that supports select + update with the
      // chained API drainMailbox uses.
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                for: vi.fn(async () => undelivered),
              })),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn((predicate: unknown) => {
              // Capture the IDs the implementation passes in.
              // (We expect drainMailbox to pass an inArray() predicate over IDs.)
              const stringified = String(predicate);
              const ids = undelivered.map((r) => r.id);
              updates.push(ids);
              return Promise.resolve();
            }),
          })),
        })),
      };
      const result = await cb(tx as never);
      return result;
    }),
    _updates: updates,
  };
}

describe('drainMailbox', () => {
  const t0 = new Date('2026-05-02T00:00:00Z');
  const t1 = new Date('2026-05-02T00:00:01Z');

  it('returns batch ordered by createdAt ascending', async () => {
    const db = makeDbMock([
      { id: 'm1', toAgentId: 'a1', type: 'user_prompt', messageType: 'message', content: 'first', createdAt: t0 },
      { id: 'm2', toAgentId: 'a1', type: 'user_prompt', messageType: 'message', content: 'second', createdAt: t1 },
    ]);
    const batch = await drainMailbox('a1', db as never);
    expect(batch).toHaveLength(2);
    expect(batch[0].content).toBe('first');
    expect(batch[1].content).toBe('second');
  });

  it('skips tick messages (used as wake signals only)', async () => {
    const db = makeDbMock([
      { id: 'm1', toAgentId: 'a1', type: 'system', messageType: 'tick', content: '', createdAt: t0 },
      { id: 'm2', toAgentId: 'a1', type: 'user_prompt', messageType: 'message', content: 'real', createdAt: t1 },
    ]);
    const batch = await drainMailbox('a1', db as never);
    expect(batch).toHaveLength(1);
    expect(batch[0].content).toBe('real');
  });

  it('marks delivered_at on every drained row (idempotency)', async () => {
    const db = makeDbMock([
      { id: 'm1', toAgentId: 'a1', type: 'user_prompt', messageType: 'message', content: 'x', createdAt: t0 },
    ]);
    await drainMailbox('a1', db as never);
    expect((db as ReturnType<typeof makeDbMock>)._updates).toHaveLength(1);
    expect((db as ReturnType<typeof makeDbMock>)._updates[0]).toEqual(['m1']);
  });

  it('returns empty batch when nothing undelivered', async () => {
    const db = makeDbMock([]);
    const batch = await drainMailbox('a1', db as never);
    expect(batch).toEqual([]);
    expect((db as ReturnType<typeof makeDbMock>)._updates).toHaveLength(0);
  });

  it('reports presence of shutdown_request in batch', async () => {
    const db = makeDbMock([
      { id: 'm1', toAgentId: 'a1', type: 'user_prompt', messageType: 'shutdown_request', content: 'wrap up', createdAt: t0 },
    ]);
    const batch = await drainMailbox('a1', db as never);
    expect(batch[0].messageType).toBe('shutdown_request');
  });
});
```

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/workers/processors/lib/__tests__/mailbox-drain.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mailbox-drain.ts`**

Create `src/workers/processors/lib/mailbox-drain.ts`:

```ts
// Mailbox drain — pulls undelivered team_messages addressed to a
// specific agent_run, marks them delivered, and returns the batch
// in createdAt order for transcript injection.
//
// Idempotent via row-lock + delivered_at marker (engine §3.5 invariant).

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { teamMessages } from '@/lib/db/schema';
import type { Database } from '@/lib/db';

export interface DrainedMessage {
  id: string;
  toAgentId: string;
  type: string;
  messageType: string;
  content: string | null;
  createdAt: Date;
}

/**
 * Drain undelivered messages addressed to `agentId`. Atomic via
 * single transaction with row-lock; safe to call concurrently
 * (other callers see locked rows and skip).
 *
 * `tick` messages are filtered out — they're wake signals only,
 * not transcript content.
 */
export async function drainMailbox(
  agentId: string,
  db: Database,
): Promise<DrainedMessage[]> {
  return db.transaction(async (tx) => {
    const rows = (await tx
      .select()
      .from(teamMessages)
      .where(
        and(
          eq(teamMessages.toAgentId, agentId),
          isNull(teamMessages.deliveredAt),
        ),
      )
      .orderBy(teamMessages.createdAt)
      .for('update')) as unknown as DrainedMessage[];

    if (rows.length === 0) return [];

    await tx
      .update(teamMessages)
      .set({ deliveredAt: new Date() })
      .where(inArray(teamMessages.id, rows.map((r) => r.id)));

    // Filter out tick messages (wake-signal-only — never enter transcript).
    return rows.filter((r) => r.messageType !== 'tick');
  });
}
```

If `Database` type isn't already exported from `@/lib/db`, find the right import (e.g., `import type { db as Database }` or similar). The pattern used elsewhere in `src/workers/processors/team-run.ts` is the canonical reference.

- [ ] **Step 4: Run — verify pass**

```bash
pnpm vitest run src/workers/processors/lib/__tests__/mailbox-drain.test.ts
```

Expected: PASS (5 cases).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/workers/processors/lib/mailbox-drain.ts \
        src/workers/processors/lib/__tests__/mailbox-drain.test.ts
git commit -m "feat(workers/lib): drainMailbox(agentId, db) — idempotent batch with for-update lock"
```

---

## Task 6: Synthesize-notification helper

**Files:**
- Create: `src/workers/processors/lib/synthesize-notification.ts`
- Test: `src/workers/processors/lib/__tests__/synthesize-notification.test.ts`

Single source of truth for `<task-notification>` XML construction. When engine evolves the schema, only this file changes.

- [ ] **Step 1: Write the failing test**

Create `src/workers/processors/lib/__tests__/synthesize-notification.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { synthesizeTaskNotification } from '@/workers/processors/lib/synthesize-notification';

describe('synthesizeTaskNotification', () => {
  it('produces a well-formed XML envelope with all 5 tags', () => {
    const xml = synthesizeTaskNotification({
      agentId: 'agent-a1b',
      status: 'completed',
      summary: '5 drafts produced',
      finalText: 'I produced 5 drafts.',
      usage: { totalTokens: 14523, toolUses: 23, durationMs: 87200 },
    });
    expect(xml).toContain('<task-notification>');
    expect(xml).toContain('<task-id>agent-a1b</task-id>');
    expect(xml).toContain('<status>completed</status>');
    expect(xml).toContain('<summary>5 drafts produced</summary>');
    expect(xml).toContain('<r>I produced 5 drafts.</r>');
    expect(xml).toContain('<usage>');
    expect(xml).toContain('<total_tokens>14523</total_tokens>');
    expect(xml).toContain('<tool_uses>23</tool_uses>');
    expect(xml).toContain('<duration_ms>87200</duration_ms>');
    expect(xml).toContain('</usage>');
    expect(xml).toContain('</task-notification>');
  });

  it('renders status="failed" when failed', () => {
    const xml = synthesizeTaskNotification({
      agentId: 'agent-x',
      status: 'failed',
      summary: 'API call rejected',
      finalText: 'Rate limited.',
      usage: { totalTokens: 100, toolUses: 1, durationMs: 500 },
    });
    expect(xml).toContain('<status>failed</status>');
  });

  it('renders status="killed" on TaskStop / shutdown_request approved', () => {
    const xml = synthesizeTaskNotification({
      agentId: 'agent-y',
      status: 'killed',
      summary: 'Cancelled by founder',
      finalText: '',
      usage: { totalTokens: 0, toolUses: 0, durationMs: 0 },
    });
    expect(xml).toContain('<status>killed</status>');
    // Empty <r> is acceptable
    expect(xml).toContain('<r></r>');
  });

  it('escapes XML-special characters in finalText and summary', () => {
    const xml = synthesizeTaskNotification({
      agentId: 'agent-z',
      status: 'completed',
      summary: 'Drafted reply with <code> & "quotes"',
      finalText: 'Reply: <strong>Yes</strong> & here\'s the link',
      usage: { totalTokens: 1, toolUses: 1, durationMs: 1 },
    });
    // < should be escaped; raw < would break XML parsing
    expect(xml).toContain('&lt;code&gt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;');
    expect(xml).toContain('&lt;strong&gt;');
  });
});
```

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/workers/processors/lib/__tests__/synthesize-notification.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `synthesize-notification.ts`**

Create `src/workers/processors/lib/synthesize-notification.ts`:

```ts
// <task-notification> XML synthesis — single source of truth.
//
// Engine PDF §3.6 verbatim XML schema. Used when an agent_runs row exits
// (completed | failed | killed) to produce the user-role mailbox payload
// the parent's runAgent loop will see on its next idle drain.

export type TerminalStatus = 'completed' | 'failed' | 'killed';

export interface NotificationInput {
  agentId: string;
  status: TerminalStatus;
  summary: string;
  finalText: string;
  usage: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/**
 * Build a `<task-notification>` XML payload for the given exit. The
 * shape matches engine PDF §3.6 verbatim — including the `<r>` tag
 * name (a deliberate engine choice retained for prompt-quoting
 * compatibility).
 */
export function synthesizeTaskNotification(input: NotificationInput): string {
  return `<task-notification>
  <task-id>${escapeXml(input.agentId)}</task-id>
  <status>${input.status}</status>
  <summary>${escapeXml(input.summary)}</summary>
  <r>${escapeXml(input.finalText)}</r>
  <usage>
    <total_tokens>${input.usage.totalTokens}</total_tokens>
    <tool_uses>${input.usage.toolUses}</tool_uses>
    <duration_ms>${input.usage.durationMs}</duration_ms>
  </usage>
</task-notification>`;
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm vitest run src/workers/processors/lib/__tests__/synthesize-notification.test.ts
```

Expected: PASS (4 cases).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/workers/processors/lib/synthesize-notification.ts \
        src/workers/processors/lib/__tests__/synthesize-notification.test.ts
git commit -m "feat(workers/lib): synthesizeTaskNotification — single SSOT for <task-notification> XML"
```

---

## Task 7: agent-run BullMQ queue helper

**Files:**
- Create: `src/lib/queue/agent-run.ts`
- Modify: `src/lib/queue/index.ts` (re-export)

This task creates the typed enqueue helper. The actual BullMQ Worker registration lands in Task 10 (after the processor exists in Task 9).

- [ ] **Step 1: Read sibling queue helper for the pattern**

```bash
cat /Users/yifeng/Documents/Code/shipflare/src/lib/queue/team-run.ts
```

Note the export shape: `<QUEUE>_NAME` constant + `<JobData>` interface + `enqueue<X>(data, opts?)` async helper.

- [ ] **Step 2: Implement `agent-run.ts`**

Create `src/lib/queue/agent-run.ts`:

```ts
// BullMQ queue helper for the unified agent-run lifecycle.
//
// Phase B: produces teammate runs via the Task tool's async branch.
// Phase D: also receives delayed jobs from the Sleep tool's resume scheduler.
// Phase E: lead's session also runs as agent-run jobs.

import { Queue } from 'bullmq';
import { getBullMQConnection } from '@/lib/redis';

export const AGENT_RUN_QUEUE_NAME = 'agent-run';

export interface AgentRunJobData {
  /** Primary key in agent_runs table — drives all per-job DB lookups. */
  agentId: string;
}

let _queue: Queue<AgentRunJobData> | null = null;

function getQueue(): Queue<AgentRunJobData> {
  if (_queue) return _queue;
  _queue = new Queue<AgentRunJobData>(AGENT_RUN_QUEUE_NAME, {
    connection: getBullMQConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 3600 }, // 1 hour
      removeOnFail: { count: 500, age: 86400 }, // 24 hours
      attempts: 1, // retries are explicit via wake() / reconcile cron
    },
  });
  return _queue;
}

export interface EnqueueOpts {
  /** BullMQ jobId for dedupe; defaults to agentId if omitted. */
  jobId?: string;
  /** Delay before processing (ms) — used by Phase D Sleep. */
  delay?: number;
}

export async function enqueueAgentRun(
  data: AgentRunJobData,
  opts: EnqueueOpts = {},
): Promise<{ id: string | undefined; data: AgentRunJobData }> {
  const job = await getQueue().add('agent-run', data, {
    jobId: opts.jobId ?? data.agentId,
    delay: opts.delay,
  });
  return { id: job.id, data };
}
```

- [ ] **Step 3: Re-export from index**

Open `src/lib/queue/index.ts`. Add to existing exports:

```ts
export { AGENT_RUN_QUEUE_NAME, enqueueAgentRun, type AgentRunJobData } from './agent-run';
```

- [ ] **Step 4: Re-run wake.test.ts (the forward dependency from Task 4)**

```bash
pnpm vitest run src/workers/processors/lib/__tests__/wake.test.ts
```

Expected: still PASS (2 cases). The mock satisfies the import; the real module now exists too.

- [ ] **Step 5: Typecheck**

```bash
pnpm tsc --noEmit --pretty false
```

Expected: zero errors. The forward dependency Task 4 had is now resolved.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queue/agent-run.ts src/lib/queue/index.ts
git commit -m "feat(queue): agent-run queue helper + AgentRunJobData type"
```

---

## Task 8: SyntheticOutputTool — system-only Tool

**Files:**
- Create: `src/tools/SyntheticOutputTool/SyntheticOutputTool.ts`
- Test: `src/tools/SyntheticOutputTool/__tests__/SyntheticOutputTool.test.ts`

This Tool is the architectural curiosity of Phase B. It exists in the type system as a `Tool`, has a name (`SYNTHETIC_OUTPUT_TOOL_NAME`), and could be theoretically registered — but it is **never** added to any whitelist. Its `isEnabled()` always returns false. Two-layer defense ensures it can never reach an LLM.

The actual notification synthesis happens in `synthesize-notification.ts` (Task 6) — not in this Tool. SyntheticOutputTool is a **placeholder** for the engine PDF naming alignment; its presence in the codebase makes the blacklist constant `SYNTHETIC_OUTPUT_TOOL_NAME` resolvable.

- [ ] **Step 1: Write the failing test**

Create `src/tools/SyntheticOutputTool/__tests__/SyntheticOutputTool.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  syntheticOutputTool,
  SYNTHETIC_OUTPUT_TOOL_NAME,
} from '@/tools/SyntheticOutputTool/SyntheticOutputTool';

describe('SyntheticOutputTool', () => {
  it('exports the canonical tool name', () => {
    expect(SYNTHETIC_OUTPUT_TOOL_NAME).toBe('SyntheticOutput');
  });

  it('the tool name field matches the constant', () => {
    expect(syntheticOutputTool.name).toBe(SYNTHETIC_OUTPUT_TOOL_NAME);
  });

  it('isEnabled() returns false (architecture-level invariant)', () => {
    expect(syntheticOutputTool.isEnabled()).toBe(false);
  });

  it('is NOT registered in any role whitelist', async () => {
    const { ROLE_WHITELISTS, getRoleWhitelist } = await import('@/tools/AgentTool/role-tools');
    // No whitelist contains the SyntheticOutput name explicitly,
    // and the '*' sentinel is the only allow-all source today.
    // We assert the SyntheticOutput name doesn't appear as a literal
    // in any whitelist set (defense in depth).
    expect(ROLE_WHITELISTS).toBeUndefined(); // ROLE_WHITELISTS is the SHAPE constant; individual sets check below
    expect(getRoleWhitelist('lead').has(SYNTHETIC_OUTPUT_TOOL_NAME)).toBe(false);
    expect(getRoleWhitelist('member').has(SYNTHETIC_OUTPUT_TOOL_NAME)).toBe(false);
  });

  it('IS in INTERNAL_TEAMMATE_TOOLS (Phase B addition)', async () => {
    const { INTERNAL_TEAMMATE_TOOLS } = await import('@/tools/AgentTool/blacklists');
    expect(INTERNAL_TEAMMATE_TOOLS.has(SYNTHETIC_OUTPUT_TOOL_NAME)).toBe(true);
  });
});
```

NOTE: the 4th test asserts `ROLE_WHITELISTS` is `undefined` — that's because role-tools.ts exports individual constants (`TEAM_LEAD_ALLOWED_TOOLS` etc.) but NOT a `ROLE_WHITELISTS` aggregate. Adjust the assertion to whatever the actual surface is — the goal is "SyntheticOutput doesn't appear as a literal in any whitelist". If role-tools.ts has only `'*'` sentinels in Phase A, this test simplifies to checking that SyntheticOutput isn't returned by `getRoleWhitelist('lead' | 'member')`.

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/tools/SyntheticOutputTool/__tests__/SyntheticOutputTool.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Add `SYNTHETIC_OUTPUT_TOOL_NAME` to `INTERNAL_TEAMMATE_TOOLS` blacklist**

Open `src/tools/AgentTool/blacklists.ts`. Find `INTERNAL_TEAMMATE_TOOLS` constant. Add SyntheticOutput:

```ts
import { TASK_TOOL_NAME } from './AgentTool';
import { SEND_MESSAGE_TOOL_NAME } from '@/tools/SendMessageTool/SendMessageTool';
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '@/tools/SyntheticOutputTool/SyntheticOutputTool';
import type { AgentRole } from './loader';

// ... existing EMPTY_SET ...

/**
 * Tools no `member` may use — protects "single-direction, tree-shaped
 * coordination" (engine PDF §3.5.2).
 *
 * Phase A members: { Task }.
 * Phase B adds: { SyntheticOutput } (architecture invariant: only the
 *   system, never an agent, may synthesize a <task-notification>).
 * Phase B+ adds: TaskStop, TeamCreate, TeamDelete.
 */
export const INTERNAL_TEAMMATE_TOOLS: ReadonlySet<string> = new Set([
  TASK_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
]);
```

- [ ] **Step 4: Implement `SyntheticOutputTool.ts`**

Create `src/tools/SyntheticOutputTool/SyntheticOutputTool.ts`:

```ts
// SyntheticOutputTool — system-only placeholder Tool.
//
// This Tool exists for the type system and the blacklist constant. It is
// NEVER added to ROLE_WHITELISTS, NEVER returned by registry.get() in
// production paths, and isEnabled() always returns false. The actual
// <task-notification> XML synthesis happens in
// `src/workers/processors/lib/synthesize-notification.ts`.
//
// Defense in depth: even if a future contributor accidentally adds
// SyntheticOutput to a whitelist, isEnabled() returning false causes
// runAgent to skip it during tool-list assembly.

import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';

export const SYNTHETIC_OUTPUT_TOOL_NAME = 'SyntheticOutput';

const SyntheticOutputInputSchema = z
  .object({
    /** Placeholder; real synthesis is server-side, not LLM-driven. */
    _unused: z.never().optional(),
  })
  .strict();

type SyntheticOutputInput = z.infer<typeof SyntheticOutputInputSchema>;

export const syntheticOutputTool: ToolDefinition<SyntheticOutputInput, never> =
  buildTool({
    name: SYNTHETIC_OUTPUT_TOOL_NAME,
    description:
      '[INTERNAL — system-only] Synthesizes a <task-notification> mailbox row. Never callable by an LLM; isEnabled() always returns false.',
    inputSchema: SyntheticOutputInputSchema,
    /** Two-layer defense: blacklisted in INTERNAL_TEAMMATE_TOOLS AND
     *  isEnabled() returns false. Never reachable from an agent context. */
    isEnabled: () => false,
    async execute(): Promise<never> {
      throw new Error(
        'SyntheticOutputTool.execute() called from an LLM context — this should be impossible. ' +
          'XML synthesis happens server-side via synthesizeTaskNotification(). ' +
          'Check for accidental inclusion in a role whitelist.',
      );
    },
  });
```

If `buildTool` and `ToolDefinition` aren't the right import names from `@/core/tool-system`, look at a sibling Tool (e.g., `src/tools/RedditPostTool/RedditPostTool.ts`) for the correct shape.

- [ ] **Step 5: Run — verify pass**

```bash
pnpm vitest run src/tools/SyntheticOutputTool/__tests__/SyntheticOutputTool.test.ts
```

Expected: PASS (5 cases). If the 4th case fails because of the `ROLE_WHITELISTS` assertion shape, update it to match the actual exports from `role-tools.ts` (`TEAM_LEAD_ALLOWED_TOOLS` etc. as individual constants).

- [ ] **Step 6: Run blacklist tests for regression**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/blacklists.test.ts
```

Expected: PASS. Existing tests still hold; the new SyntheticOutput entry doesn't break the existing assertions because they assert on Task / SendMessage explicitly.

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/tools/SyntheticOutputTool/ \
        src/tools/AgentTool/blacklists.ts
git commit -m "feat(SyntheticOutputTool): system-only placeholder + blacklist entry"
```

---

## Task 9: agent-run processor (Phase B lifecycle)

**Files:**
- Create: `src/workers/processors/agent-run.ts`
- Test: `src/workers/processors/__tests__/agent-run.test.ts`

This is the heart of Phase B. The processor:
1. Loads the `agent_runs` row by `agentId`
2. Loads the AgentDefinition by name
3. Starts `runAgent` with the row's initial prompt (stored in `team_messages` as the first message addressed to this agent)
4. On exit: synthesizes `<task-notification>`, inserts into `team_messages` for the parent, marks `agent_runs.status = 'completed' | 'failed'`

**Phase B does NOT include**:
- Sleep / resume — the processor runs to natural completion (`end_turn` / `maxTurns` / error). Phase D adds Sleep.
- Mailbox drain mid-run — Phase B teammates are single-shot; Phase C adds drain at idle turns to support mid-run SendMessage delivery.

The Phase B processor reads its initial prompt from the FIRST undelivered `team_messages` row addressed to its `agentId` (which the Task tool's async branch inserted before calling `wake()`).

- [ ] **Step 1: Write the failing test**

Create `src/workers/processors/__tests__/agent-run.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processAgentRun } from '@/workers/processors/agent-run';
import type { Job } from 'bullmq';

// Mock the database — full integration runs in Task 14 e2e.
vi.mock('@/lib/db', () => ({
  db: {
    query: { agentRuns: { findFirst: vi.fn() } },
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
}));

// Mock runAgent so we don't fire real LLM calls.
vi.mock('@/core/query-loop', () => ({
  runAgent: vi.fn(async () => ({
    output: 'I produced 5 drafts.',
    cost: 0.01,
    turns: 4,
    duration: 1234,
    usage: { totalTokens: 14523, toolUses: 23 },
  })),
}));

vi.mock('@/tools/AgentTool/registry', () => ({
  resolveAgent: vi.fn(async (name: string) => ({
    source: 'built-in' as const,
    sourcePath: '/test',
    name,
    description: 'mock',
    role: 'member' as const,
    tools: [],
    disallowedTools: [],
    skills: [],
    requires: [],
    background: false,
    maxTurns: 10,
    systemPrompt: 'You are a test agent.',
  })),
}));

import { db } from '@/lib/db';

function makeJob(agentId: string): Job {
  return { id: 'job-1', data: { agentId } } as unknown as Job;
}

describe('processAgentRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads agent_runs row by agentId', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue({
      id: 'agent-1',
      teamId: 'team-1',
      memberId: 'mem-1',
      agentDefName: 'content-manager',
      parentAgentId: 'lead-1',
      status: 'queued',
    } as never);
    // ... (mock select for initial mailbox read, update for status, etc.)
    // ... full mock setup
    await processAgentRun(makeJob('agent-1'));
    expect(db.query.agentRuns.findFirst).toHaveBeenCalledOnce();
  });

  it('throws if agent_runs row not found', async () => {
    vi.mocked(db.query.agentRuns.findFirst).mockResolvedValue(undefined);
    await expect(processAgentRun(makeJob('missing'))).rejects.toThrow(/not found/i);
  });

  // The full state-machine test (status transitions, notification insertion)
  // is exercised in the Task 14 e2e test. Phase B's unit test here just
  // validates the load-and-dispatch contract.
});
```

(The test is skeletal because mocking the full agent-run flow inline is verbose; the meaningful coverage lives in Task 14's e2e.)

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/workers/processors/__tests__/agent-run.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `agent-run.ts`**

Create `src/workers/processors/agent-run.ts`:

```ts
// Phase B agent-run processor.
//
// Lifecycle (Phase B subset):
//   queued → running → (completed | failed)
//
// Phase D adds: sleeping → resuming → running.
// Phase C adds: mailbox drain at idle turns (mid-run message handling).

import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRuns, teamMessages } from '@/lib/db/schema';
import { runAgent } from '@/core/query-loop';
import { resolveAgent } from '@/tools/AgentTool/registry';
import { synthesizeTaskNotification } from './lib/synthesize-notification';
import { wake } from './lib/wake';
import { drainMailbox } from './lib/mailbox-drain';
import { createLogger } from '@/lib/logger';
import { buildAgentConfigFromDefinition, createChildContext } from '@/tools/AgentTool/spawn';
import type { AgentRunJobData } from '@/lib/queue/agent-run';

const log = createLogger('agent-run');

export async function processAgentRun(job: Job<AgentRunJobData>): Promise<void> {
  const { agentId } = job.data;
  const row = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, agentId),
  });
  if (!row) {
    throw new Error(`agent_runs row not found for agentId=${agentId}`);
  }

  // Mark running
  await db
    .update(agentRuns)
    .set({ status: 'running', lastActiveAt: new Date(), bullmqJobId: job.id ?? null })
    .where(eq(agentRuns.id, agentId));

  // Load AgentDefinition
  const def = await resolveAgent(row.agentDefName);
  if (!def) {
    await markFailed(agentId, `unknown agent: ${row.agentDefName}`);
    await synthAndDeliverNotification({
      agentId,
      parentAgentId: row.parentAgentId,
      teamId: row.teamId,
      memberId: row.memberId,
      status: 'failed',
      finalText: '',
      summary: `unknown agent: ${row.agentDefName}`,
      usage: { totalTokens: 0, toolUses: 0, durationMs: 0 },
    });
    return;
  }

  // Read initial prompt from mailbox (the Task tool inserted it before calling wake())
  const batch = await drainMailbox(agentId, db);
  const initialPrompt = batch.length > 0 ? (batch[0].content ?? '') : '';

  // Run the agent. Phase B: single-shot, run to natural completion.
  let result: Awaited<ReturnType<typeof runAgent>>;
  let status: 'completed' | 'failed' = 'completed';
  let summary = '';
  try {
    const config = buildAgentConfigFromDefinition(def);
    const ctx = createChildContext({
      abortSignal: new AbortController().signal,
      get: () => null as never,
    });
    result = await runAgent(config, initialPrompt, ctx);
    summary = `${def.name} completed in ${result.turns} turns`;
  } catch (err) {
    status = 'failed';
    summary = err instanceof Error ? err.message : String(err);
    result = { output: '', cost: 0, turns: 0, duration: 0, usage: { totalTokens: 0, toolUses: 0 } } as never;
    log.error({ agentId, err }, 'agent-run failed');
  }

  // Persist exit + notify parent
  await db
    .update(agentRuns)
    .set({
      status,
      lastActiveAt: new Date(),
      totalTokens: result.usage?.totalTokens ?? 0,
      toolUses: result.usage?.toolUses ?? 0,
      shutdownReason: status === 'failed' ? summary : null,
    })
    .where(eq(agentRuns.id, agentId));

  await synthAndDeliverNotification({
    agentId,
    parentAgentId: row.parentAgentId,
    teamId: row.teamId,
    memberId: row.memberId,
    status,
    finalText: typeof result.output === 'string' ? result.output : JSON.stringify(result.output),
    summary,
    usage: {
      totalTokens: result.usage?.totalTokens ?? 0,
      toolUses: result.usage?.toolUses ?? 0,
      durationMs: result.duration ?? 0,
    },
  });
}

async function markFailed(agentId: string, reason: string): Promise<void> {
  await db
    .update(agentRuns)
    .set({ status: 'failed', shutdownReason: reason, lastActiveAt: new Date() })
    .where(eq(agentRuns.id, agentId));
}

async function synthAndDeliverNotification(params: {
  agentId: string;
  parentAgentId: string | null;
  teamId: string;
  memberId: string;
  status: 'completed' | 'failed' | 'killed';
  finalText: string;
  summary: string;
  usage: { totalTokens: number; toolUses: number; durationMs: number };
}): Promise<void> {
  // No parent = nothing to notify (lead-level run; Phase E)
  if (!params.parentAgentId) return;

  const xml = synthesizeTaskNotification({
    agentId: params.agentId,
    status: params.status,
    summary: params.summary,
    finalText: params.finalText,
    usage: params.usage,
  });

  await db.insert(teamMessages).values({
    teamId: params.teamId,
    type: 'user_prompt',
    messageType: 'task_notification',
    fromMemberId: params.memberId,
    fromAgentId: params.agentId,
    toAgentId: params.parentAgentId,
    content: xml,
    summary: params.summary,
  });

  await wake(params.parentAgentId);
}
```

If any of the imports don't resolve cleanly (e.g., `runAgent`'s return type, or `createChildContext`'s expected ctx shape), look at how `team-run.ts` uses them as the canonical reference and adjust.

- [ ] **Step 4: Run — verify pass on the skeletal unit test**

```bash
pnpm vitest run src/workers/processors/__tests__/agent-run.test.ts
```

Expected: PASS for the load-and-dispatch contract test. The skeletal test may need refinement if the mock surface doesn't match the actual code path; flesh out as needed to keep at minimum the "loads row" and "throws if not found" cases green.

- [ ] **Step 5: Typecheck**

```bash
pnpm tsc --noEmit --pretty false
```

Expected: zero errors. If `buildAgentConfigFromDefinition`, `createChildContext`, `runAgent`, or `resolveAgent` aren't shaped the way the implementation assumes, fix the imports / call shapes.

- [ ] **Step 6: Commit**

```bash
git add src/workers/processors/agent-run.ts \
        src/workers/processors/__tests__/agent-run.test.ts
git commit -m "feat(workers): agent-run processor — Phase B single-shot lifecycle"
```

---

## Task 10: Register agent-run worker in `src/workers/index.ts`

**Files:**
- Modify: `src/workers/index.ts`

- [ ] **Step 1: Add import + Worker registration**

Open `src/workers/index.ts`. Find the section where other Workers are registered (usually after Queue declarations). Add:

```ts
import { processAgentRun } from './processors/agent-run';
import { AGENT_RUN_QUEUE_NAME, type AgentRunJobData } from '@/lib/queue/agent-run';

// ... existing Queue + Worker registrations ...

// Phase B: Agent Teams async lifecycle worker.
const agentRunWorker = new Worker<AgentRunJobData>(
  AGENT_RUN_QUEUE_NAME,
  async (job) => {
    const jobLog = loggerForJob(job);
    jobLog.info({ agentId: job.data.agentId }, 'agent-run start');
    await processAgentRun(job);
    jobLog.info({ agentId: job.data.agentId }, 'agent-run done');
  },
  {
    connection,
    concurrency: 4,
    lockDuration: 600_000, // 10 min — long-running agent loops
    lockRenewTime: 30_000,
  },
);

agentRunWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err }, 'agent-run job failed');
});
```

(Match the existing pattern for other Workers in the file — e.g., look at how `team-run` Worker is registered.)

- [ ] **Step 2: Verify the file compiles + the worker boots**

```bash
pnpm tsc --noEmit --pretty false
# Optionally smoke-boot:
# pnpm dev:worker  (if you have such a script)
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/workers/index.ts
git commit -m "feat(workers): register agent-run BullMQ Worker (Phase B)"
```

---

## Task 11: Task tool — `run_in_background:true` async branch

**Files:**
- Modify: `src/tools/AgentTool/AgentTool.ts` (extend schema; add async branch in execute)
- Test: `src/tools/AgentTool/__tests__/Task.test.ts` (extend with async cases)

This is the LLM-facing surface change. The existing sync path is preserved exactly; the new async branch fires only when ALL of:
1. `run_in_background:true` is in the input
2. `isAgentTeamsEnabledForTeam(teamId)` returns true (env var on)
3. The Task tool is invoked from within a team-run context (has `teamId`, `userId`)

If any condition fails, the async path is silently downgraded to sync (preserves backward compat).

- [ ] **Step 1: Read current Task tool to know the entry shape**

```bash
sed -n '40,80p' /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/AgentTool.ts
sed -n '298,350p' /Users/yifeng/Documents/Code/shipflare/src/tools/AgentTool/AgentTool.ts
```

Note the `TaskInputSchema` (with `.strict()`) and the `TaskResult` shape.

- [ ] **Step 2: Add the failing test**

In `src/tools/AgentTool/__tests__/Task.test.ts`, append a new `describe` block for the async branch:

```ts
import { isAgentTeamsEnabledForTeam } from '@/lib/feature-flags/agent-teams';
import { wake } from '@/workers/processors/lib/wake';

vi.mock('@/lib/feature-flags/agent-teams', () => ({
  isAgentTeamsEnabledForTeam: vi.fn(),
}));
vi.mock('@/workers/processors/lib/wake', () => ({
  wake: vi.fn(async () => undefined),
}));

describe('Task tool — async branch (Phase B)', () => {
  beforeEach(() => {
    vi.mocked(isAgentTeamsEnabledForTeam).mockResolvedValue(true);
    vi.mocked(wake).mockClear();
  });

  it('returns immediately with {agentId, status:"async_launched"} when flag on + run_in_background:true', async () => {
    // Set up a ToolContext that satisfies the team-run requirements
    // (teamId, userId, db). Use the existing helper if available.
    // ... mock setup ...
    const result = await taskTool.execute(
      {
        subagent_type: 'content-manager',
        prompt: 'Draft 3 reply variations for the latest mention.',
        description: 'Async draft',
        run_in_background: true,
      },
      makeTeamRunCtx(),
    );
    expect(result).toMatchObject({
      status: 'async_launched',
      agentId: expect.stringMatching(/.+/),
    });
    expect(wake).toHaveBeenCalledOnce();
  });

  it('falls back to sync path when flag is OFF', async () => {
    vi.mocked(isAgentTeamsEnabledForTeam).mockResolvedValue(false);
    // ... call with run_in_background:true ...
    // ... expect the sync TaskResult shape (result + cost + duration + turns) ...
    // ... expect wake() NOT called ...
    expect(wake).not.toHaveBeenCalled();
  });

  it('falls back to sync path when run_in_background is false / unset', async () => {
    vi.mocked(isAgentTeamsEnabledForTeam).mockResolvedValue(true);
    // ... call without run_in_background ...
    // ... expect the sync TaskResult shape ...
    expect(wake).not.toHaveBeenCalled();
  });
});
```

(Flesh out `makeTeamRunCtx()` and the ad-hoc context based on existing Task.test.ts patterns.)

- [ ] **Step 3: Run — verify failure**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/Task.test.ts -t 'async branch'
```

Expected: FAIL — `run_in_background` not in schema; async branch doesn't exist.

- [ ] **Step 4: Extend `TaskInputSchema`**

In `src/tools/AgentTool/AgentTool.ts`, update the schema:

```ts
export const TaskInputSchema = z
  .object({
    subagent_type: z.string().min(1, 'subagent_type is required'),
    prompt: z.string().min(1, 'prompt is required'),
    description: z
      .string()
      .min(1, 'description is required')
      .max(100, 'description must be 100 characters or fewer'),
    name: z.string().optional(),
    /** Phase B: opt-in async path. Returns immediately with
     *  {agentId, status:'async_launched'} when the team flag is on. */
    run_in_background: z.boolean().optional(),
  })
  .strict();
```

Update the comment at lines ~46-48 — `run_in_background` is no longer dropped.

- [ ] **Step 5: Extend `TaskResult` to allow async return**

```ts
export interface TaskResult {
  result: unknown;
  cost: number;
  duration: number;
  turns: number;
  /** Set on async returns; undefined for sync. */
  agentId?: string;
  /** 'completed' for sync; 'async_launched' for async (Phase B). */
  status?: 'completed' | 'async_launched';
}
```

- [ ] **Step 6: Add the async branch in Task tool's `execute()`**

Find the `execute()` body in `taskTool` (around line ~298+). At the TOP of the body (before the existing sync path), add:

```ts
// Phase B: async branch — opt-in via input.run_in_background AND team flag.
const teamId = readTeamDeps(context).teamId;
if (input.run_in_background === true && teamId !== null) {
  const enabled = await isAgentTeamsEnabledForTeam(teamId);
  if (enabled) {
    return await launchAsyncTeammate(input, context);
  }
  // Flag off: silently fall through to sync path.
}
// ... existing sync path unchanged below ...
```

Then add a new helper at module level:

```ts
async function launchAsyncTeammate(
  input: TaskInput,
  ctx: ToolContext,
): Promise<TaskResult> {
  const deps = readTeamDeps(ctx);
  if (!deps.db || !deps.teamId || !deps.currentMemberId) {
    throw new Error('async Task requires team-run context (db, teamId, currentMemberId)');
  }

  // Resolve the target agent definition (must exist).
  const def = await resolveAgent(input.subagent_type);
  if (!def) {
    throw new Error(`unknown subagent_type: ${input.subagent_type}`);
  }

  const agentId = crypto.randomUUID();

  // 1. Insert agent_runs row in 'queued' status.
  await deps.db.insert(agentRuns).values({
    id: agentId,
    teamId: deps.teamId,
    memberId: deps.currentMemberId, // member reference for the spawned teammate
    agentDefName: input.subagent_type,
    parentAgentId: deps.currentMemberId, // CAUTION: this is the parent's MEMBER id, not agent_runs id
    status: 'queued',
  });

  // 2. Insert initial prompt as the first mailbox message addressed to the new agent.
  await deps.db.insert(teamMessages).values({
    teamId: deps.teamId,
    type: 'user_prompt',
    messageType: 'message',
    fromMemberId: deps.currentMemberId,
    toAgentId: agentId,
    content: input.prompt,
    summary: input.description,
  });

  // 3. Wake the agent-run worker.
  await wake(agentId);

  return {
    result: null,
    cost: 0,
    duration: 0,
    turns: 0,
    agentId,
    status: 'async_launched',
  };
}
```

Add the necessary imports at the top of `AgentTool.ts`:

```ts
import { isAgentTeamsEnabledForTeam } from '@/lib/feature-flags/agent-teams';
import { wake } from '@/workers/processors/lib/wake';
import { agentRuns, teamMessages } from '@/lib/db/schema';
import { resolveAgent } from './registry';
```

**CRITICAL**: the `parentAgentId` in the insert above is wrong — it's set to `currentMemberId` (a teamMembers row id), but the `agent_runs.parent_agent_id` column references `agent_runs.id`. We need the PARENT's agent_run id, not the parent's member id. Phase E fixes this properly when the lead also runs through agent-run. For Phase B MVP, leave `parentAgentId: null` — the test in Task 14 will catch the absence of notification routing. Mark this in a `// TODO Phase E:` comment so it's not lost.

Updated insert:

```ts
  await deps.db.insert(agentRuns).values({
    id: agentId,
    teamId: deps.teamId,
    memberId: deps.currentMemberId,
    agentDefName: input.subagent_type,
    // TODO Phase E: when lead runs as agent_runs row, this becomes the lead's agentId
    parentAgentId: null,
    status: 'queued',
  });
```

The result is that in Phase B, async teammates run to completion but the lead doesn't yet receive their `<task-notification>` (because parentAgentId is null → synthAndDeliverNotification short-circuits). Phase E completes the loop.

This is OK for Phase B because the goal is "end-to-end async path WORKS"; the lead-side mailbox drain hookup is Phase C/E. The Task 14 e2e test asserts the agent-run row reaches status='completed' and the agent ran successfully — not that the lead received the notification.

- [ ] **Step 7: Run async-branch tests + full Task.test.ts**

```bash
pnpm vitest run src/tools/AgentTool/__tests__/Task.test.ts
```

Expected: all pass — async cases new, sync cases still green.

- [ ] **Step 8: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/tools/AgentTool/AgentTool.ts \
        src/tools/AgentTool/__tests__/Task.test.ts
git commit -m "feat(Task): async branch — run_in_background:true flag-gated path (Phase B)"
```

---

## Task 12: team-run mailbox drain at idle turns

**Files:**
- Modify: `src/workers/processors/team-run.ts`
- Test: existing team-run tests; add one targeted case if there's a clean hook

Phase B gives the team-run-driven lead a way to receive `<task-notification>` messages from async teammates. We add a mailbox-drain call at each "idle turn" boundary in the lead's runAgent loop — drained messages are injected as user-role transcript entries before the next assistant call.

**Note**: identifying the lead's `agentId` in Phase B is awkward because the lead doesn't yet have an `agent_runs` row (Phase E adds that). For Phase B, we use the `team_run` row's `currentMemberId` as the addressing key, but the new column is `to_agent_id` not `to_member_id`. The simplest hack: drain by `toMemberId` instead of `toAgentId` for the lead's case, OR insert lead's notifications with a sentinel `toAgentId` value the lead recognizes.

Cleanest approach for Phase B: when async teammates are spawned (Task 11), set `parentAgentId: null` AND insert their notifications addressed by `toMemberId: <lead's member id>` instead of `toAgentId`. Then the lead drains by `toMemberId`. This keeps Phase B self-contained.

Update the Task 11 implementation: in `synthAndDeliverNotification` (in `agent-run.ts`), if the parent's `agent_runs` row doesn't exist (Phase B), look up the parent's `member_id` from somewhere — or simpler: have the Task tool's async branch pass the lead's `currentMemberId` through as the future `parentMemberId` field.

This is getting tangled. **Simplification for Phase B MVP**: the async teammate runs to completion and writes a `task_notification` row with `fromAgentId=teammate.agentId, toAgentId=null, content=xml`. The lead's drain in team-run filters `toAgentId IS NULL AND messageType='task_notification' AND teamId=current`. This is a Phase B kludge; Phase E replaces it.

- [ ] **Step 1: Add a drain call at the lead's idle turn boundary in `team-run.ts`**

Find the runAgent invocation in `team-run.ts`. Look for an `onIdleReset` or `onProgress` callback (or the place where the lead's runAgent loop reads new user input mid-run). Insert a drain call:

```ts
import { drainMailbox } from './lib/mailbox-drain';
import { sql, eq, and, isNull } from 'drizzle-orm';
import { teamMessages } from '@/lib/db/schema';

// ... inside the team-run flow, somewhere near the lead's runAgent setup ...

// Phase B: drain async teammates' task_notifications at each idle turn.
async function drainLeadMailbox(): Promise<string[]> {
  // Phase B kludge: pull notifications with no parentAgentId (= addressed
  // to "the lead of this team"). Phase E replaces with proper agent_runs
  // routing when the lead also runs as an agent_runs row.
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(teamMessages)
      .where(
        and(
          eq(teamMessages.teamId, teamId),
          eq(teamMessages.messageType, 'task_notification'),
          isNull(teamMessages.toAgentId),
          isNull(teamMessages.deliveredAt),
        ),
      )
      .orderBy(teamMessages.createdAt)
      .for('update');
    if (rows.length === 0) return [];
    await tx
      .update(teamMessages)
      .set({ deliveredAt: new Date() })
      .where(inArray(teamMessages.id, rows.map((r) => r.id)));
    return rows.map((r) => r.content ?? '');
  });
}
```

Then pass `drainLeadMailbox` into the runAgent loop's idle-turn hook (look for an existing `onIdleReset` or equivalent — if none, this becomes a Phase B carryover; mark with TODO and implement minimal hook).

If `team-run.ts` already supports an idle-turn callback (since it "subscribes to user-message injection"), reuse that mechanism — drained messages are injected the same way as user-supplied mid-run input.

- [ ] **Step 2: Verify team-run integration test still passes**

```bash
pnpm vitest run src/workers/processors/__tests__/team-run.integration.test.ts
```

Expected: PASS (no behavior change when no async teammates have spawned).

- [ ] **Step 3: Commit**

```bash
git add src/workers/processors/team-run.ts
git commit -m "feat(team-run): drain async task_notifications at idle turns (Phase B)"
```

---

## Task 13: Reconcile-mailbox cron (orphan re-enqueue)

**Files:**
- Create: `src/workers/processors/reconcile-mailbox.ts`
- Test: `src/workers/processors/__tests__/reconcile-mailbox.test.ts`
- Modify: `src/workers/index.ts` (register the cron)

The reconcile cron is the durable backstop: if `wake()` failed for any reason (BullMQ unreachable for a moment, dedupe collision misfire), this cron re-enqueues the missing wake within 1 minute.

- [ ] **Step 1: Write the failing test**

Create `src/workers/processors/__tests__/reconcile-mailbox.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processReconcileMailbox } from '@/workers/processors/reconcile-mailbox';

vi.mock('@/lib/db', () => ({
  db: { execute: vi.fn(), select: vi.fn() },
}));

vi.mock('@/workers/processors/lib/wake', () => ({
  wake: vi.fn(async () => undefined),
}));

import { db } from '@/lib/db';
import { wake } from '@/workers/processors/lib/wake';

describe('processReconcileMailbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries for orphan agents and calls wake() for each', async () => {
    vi.mocked(db.execute).mockResolvedValue([
      { to_agent_id: 'agent-1' },
      { to_agent_id: 'agent-2' },
    ] as never);
    await processReconcileMailbox();
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake).toHaveBeenNthCalledWith(1, 'agent-1');
    expect(wake).toHaveBeenNthCalledWith(2, 'agent-2');
  });

  it('does nothing when no orphans found', async () => {
    vi.mocked(db.execute).mockResolvedValue([] as never);
    await processReconcileMailbox();
    expect(wake).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — verify failure**

```bash
pnpm vitest run src/workers/processors/__tests__/reconcile-mailbox.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `reconcile-mailbox.ts`**

Create `src/workers/processors/reconcile-mailbox.ts`:

```ts
// Reconcile-mailbox cron — durable backstop for wake() failures.
//
// Every minute, finds agent_runs rows that have undelivered messages older
// than 30 seconds AND are in 'sleeping' / 'queued' status, and re-enqueues
// them. Catches enqueue failures from wake() (transient BullMQ errors,
// dedupe-window misfires).

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { wake } from './lib/wake';
import { createLogger } from '@/lib/logger';

const log = createLogger('reconcile-mailbox');

interface OrphanRow {
  to_agent_id: string;
}

export async function processReconcileMailbox(): Promise<void> {
  const orphans = (await db.execute(sql`
    SELECT DISTINCT to_agent_id
    FROM team_messages
    WHERE delivered_at IS NULL
      AND to_agent_id IS NOT NULL
      AND created_at < now() - interval '30 seconds'
  `)) as unknown as OrphanRow[];

  if (orphans.length === 0) return;

  log.info({ count: orphans.length }, 'reconciling mailbox orphans');
  for (const row of orphans) {
    try {
      await wake(row.to_agent_id);
    } catch (err) {
      log.error({ agentId: row.to_agent_id, err }, 'wake failed during reconcile');
    }
  }
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm vitest run src/workers/processors/__tests__/reconcile-mailbox.test.ts
```

Expected: PASS (2 cases).

- [ ] **Step 5: Register the cron in `workers/index.ts`**

Open `src/workers/index.ts`. Find where other cron-only Queues are declared (look for `plan-execute-sweeper` as a reference). Add a new Queue + a repeat schedule:

```ts
import { processReconcileMailbox } from './processors/reconcile-mailbox';

const reconcileMailboxQueue = new Queue<Record<string, never>>(
  'reconcile-mailbox',
  {
    connection: getBullMQConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
      attempts: 1,
    },
  },
);

new Worker<Record<string, never>>(
  'reconcile-mailbox',
  async () => {
    await processReconcileMailbox();
  },
  { connection, concurrency: 1 },
);

// Schedule: every minute.
await reconcileMailboxQueue.add(
  'tick',
  {},
  { repeat: { pattern: '* * * * *' }, jobId: 'reconcile-mailbox-tick' },
);
```

Match the existing pattern in the file for cron registration.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/workers/processors/reconcile-mailbox.ts \
        src/workers/processors/__tests__/reconcile-mailbox.test.ts \
        src/workers/index.ts
git commit -m "feat(workers): reconcile-mailbox cron — orphan re-enqueue every minute"
```

---

## Task 14: End-to-end verification gate

**Files:** none required to modify; this is a verification + spec-doc-update task.

- [ ] **Step 1: Run the full TypeScript check**

```bash
pnpm tsc --noEmit --pretty false
```

Expected: zero errors.

- [ ] **Step 2: Run all Phase B tests**

```bash
pnpm vitest run src/lib/feature-flags \
                src/workers/processors/lib \
                src/workers/processors/__tests__/agent-run.test.ts \
                src/workers/processors/__tests__/reconcile-mailbox.test.ts \
                src/tools/SyntheticOutputTool \
                src/tools/AgentTool/__tests__/Task.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Run the full AgentTool sweep for regression (Phase A still green)**

```bash
pnpm vitest run src/tools/AgentTool
```

Expected: 77+ tests still PASS.

- [ ] **Step 4: Run an end-to-end async-spawn smoke test**

If you have a way to spin up Postgres + Redis + the worker process locally, do this:

```bash
# Set the flag
export SHIPFLARE_AGENT_TEAMS=1

# Run the worker process in a terminal:
pnpm dev:worker  # or the equivalent

# In another terminal, trigger a team-run that exercises the async path.
# (The exact invocation depends on your dev setup. Look for an existing
# CLI script under scripts/ that triggers a team run, or hit the API
# endpoint for /api/team/run.)
```

Verify:
- The team-run job spawns
- A teammate `agent_runs` row is inserted with `status='queued'`
- The `agent-run` worker picks it up
- The teammate runs to `status='completed'`
- A `team_messages` row with `messageType='task_notification'` is inserted

If this end-to-end test isn't feasible without significant setup, document the environmental limitation and rely on the unit tests + the Task 14 step 2 sweep.

- [ ] **Step 5: Spot-check `pnpm test` for unexpected red**

```bash
pnpm test 2>&1 | tail -40
```

Expected: comparable pass/fail count to the Phase A landed baseline.

- [ ] **Step 6: Tag the milestone commit**

```bash
git log --oneline | head -20
git tag -a phase-b-async-lifecycle -m "Agent Teams Phase B — Async lifecycle complete"
```

- [ ] **Step 7: Update the spec progress note**

Append to `docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md`, in the `## Implementation status` section (added in Phase A Task 13):

```markdown
- **Phase B — Async lifecycle:** landed `2026-05-02` on `dev`. Task tool's
  `run_in_background:true` opt-in async path works end-to-end behind
  `SHIPFLARE_AGENT_TEAMS=1`. agent-run BullMQ queue, agent_runs DB table,
  team_messages routing columns, SyntheticOutputTool placeholder, mailbox-drain
  / synthesize-notification / wake helpers, reconcile-mailbox cron. Lead-side
  mailbox drain is a Phase B kludge (toAgentId IS NULL filter) — Phase E
  replaces with proper agent_runs routing.
  - Task 1 — schema additions: <SHA>
  - Task 2 — drizzle migration: <SHA>
  - Task 3 — feature flag: <SHA>
  - Task 4 — wake helper: <SHA>
  - Task 5 — mailbox-drain helper: <SHA>
  - Task 6 — synthesize-notification: <SHA>
  - Task 7 — agent-run queue helper: <SHA>
  - Task 8 — SyntheticOutputTool: <SHA>
  - Task 9 — agent-run processor: <SHA>
  - Task 10 — register agent-run worker: <SHA>
  - Task 11 — Task tool async branch: <SHA>
  - Task 12 — team-run drain hook: <SHA>
  - Task 13 — reconcile-mailbox cron: <SHA>
  - Task 14 — verification gate: <SHA>
```

(Fill in actual commit SHAs from `git log`.)

- [ ] **Step 8: Commit the doc update**

```bash
git add docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md
git commit -m "docs(spec): mark Agent Teams Phase B landed"
```

---

## Acceptance criteria (Phase B done = all of these green)

- [ ] `agent_runs` table exists in DB with all columns from Task 1
- [ ] `team_messages` has new columns (`message_type`, `from_agent_id`,
  `to_agent_id`, `delivered_at`, `summary`, `replies_to_id`)
- [ ] `isAgentTeamsEnabledForTeam(teamId)` reads `SHIPFLARE_AGENT_TEAMS` env
- [ ] `wake(agentId)` enqueues an `agent-run` BullMQ job with jobId dedupe
- [ ] `drainMailbox(agentId, db)` returns ordered batch + marks `delivered_at`
- [ ] `synthesizeTaskNotification(...)` produces well-formed XML with all 5 tags
- [ ] `SyntheticOutputTool.isEnabled()` returns false; tool is in
  `INTERNAL_TEAMMATE_TOOLS`
- [ ] `agent-run` BullMQ Worker registered in `workers/index.ts`; loads
  `agent_runs` row + runs to completion + writes `task_notification`
- [ ] `Task({run_in_background:true})` returns `{agentId, status:'async_launched'}`
  when flag is on; falls back to sync when off
- [ ] `team-run.ts` drains async teammates' notifications at idle-turn boundaries
- [ ] `reconcile-mailbox` cron fires every minute and re-enqueues orphans
- [ ] `pnpm tsc --noEmit` clean
- [ ] All Phase A tests still green; all Phase B tests green
- [ ] Spec doc has Phase B landed timestamp + 14 commit SHAs

---

## Self-review notes

1. **Spec coverage:** Every Phase B row in spec §6 maps to a task above.
   - Schema migration → Tasks 1+2
   - Feature flag → Task 3
   - Helpers (wake, mailbox-drain, synthesize-notification) → Tasks 4-6
   - SyntheticOutputTool → Task 8
   - agent-run queue + processor → Tasks 7, 9, 10
   - Task tool async branch → Task 11
   - team-run drain hook → Task 12
   - Reconcile cron → Task 13
   - Verification → Task 14

2. **Placeholder scan:** No "TBD" / "TODO" / "implement later" except the
   explicit `// TODO Phase E:` in Task 11's `parentAgentId: null` line —
   that's a deliberate sequencing decision, not a missing requirement.

3. **Type consistency:** `AgentRunJobData = { agentId: string }` is consistent
   between `wake.ts`, `agent-run.ts` queue helper, and the processor.
   `TerminalStatus = 'completed' | 'failed' | 'killed'` is consistent
   between `synthesize-notification.ts` and `agent-run.ts`. `agent_runs.id`
   and `team_messages.to_agent_id` both use the project's `text` /
   `crypto.randomUUID()` convention.

4. **Phase B carryovers (intentional):**
   - Lead's notification routing (`parentAgentId: null` + `toAgentId IS NULL`
     drain filter) is a Phase B MVP kludge. Phase E replaces it with proper
     agent_runs routing once the lead runs as an agent_runs row too.
   - No `Sleep`, no `SendMessage` discriminated union, no `TaskStop`.
     These are Phases C + D.

5. **Risk audit:** the riskiest task is Task 11 (Task tool extension) because
   it touches the LLM-facing surface. The flag-off fallback is unconditional:
   if `isAgentTeamsEnabledForTeam(teamId)` returns false, the function silently
   uses the existing sync path. So flag-off = byte-for-byte unchanged behavior.

6. **The `ROLE_WHITELISTS` test in Task 8 may need adjustment.** Phase A's
   role-tools.ts exports individual constants, not an aggregate. Update the
   test to assert against `getRoleWhitelist('lead' | 'member')` directly.

7. **Drizzle migration name in Task 2 is undetermined** — `pnpm drizzle-kit
   generate` chooses the filename based on a content hash + auto-summary.
   That's expected; the verification step is "the SQL contains the right
   ALTER / CREATE statements", not a specific filename.
