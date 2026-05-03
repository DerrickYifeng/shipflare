/**
 * SendMessage tool unit tests.
 *
 * Strategy: inject a fake db + fake Redis publisher via ToolContext.get, so
 * we can assert both the INSERT and the PUBLISH happened without standing
 * up Postgres or Redis.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolContext } from '@/core/types';

// ---------------------------------------------------------------------------
// In-memory fixtures
// ---------------------------------------------------------------------------

interface MemberRow {
  id: string;
  teamId: string;
  displayName: string;
  /** Phase C Task 5: needed by getRoleOfMember → resolveAgent(agentType).role. */
  agentType?: string;
}

interface MessageRow {
  id: string;
  runId: string | null;
  teamId: string;
  fromMemberId: string | null;
  toMemberId: string | null;
  type: string;
  content: string | null;
}

/**
 * Phase D Task 6: in-memory `agent_runs` rows so tests can model
 * "recipient is sleeping" without standing up Postgres. The fakeDb
 * detects an agent_runs query by sniffing for a `'sleeping'` filter
 * value (uniquely identifying — `team_members` never carries that
 * literal as a column value).
 */
interface AgentRunRow {
  id: string;
  memberId: string;
  status: 'sleeping' | 'running' | 'queued' | 'completed' | 'failed';
}

const members: MemberRow[] = [];
const inserts: MessageRow[] = [];
const agentRunRows: AgentRunRow[] = [];

// ---------------------------------------------------------------------------
// Fake drizzle query builders
// ---------------------------------------------------------------------------
//
// We only need to service exactly the two queries SendMessage issues:
//   (a) SELECT id FROM team_members WHERE id=? AND team_id=? LIMIT 1
//   (b) SELECT id FROM team_members WHERE display_name=? AND team_id=? LIMIT 2
//   (c) INSERT INTO team_messages (...)
//
// We intercept drizzle-orm's `eq` + `and` so they emit sentinel objects we
// can decode in the mock; the chainable builder then reads those sentinels.

interface EqSentinel {
  __eq: { column: string; value: unknown };
}
interface AndSentinel {
  __and: Array<EqSentinel | AndSentinel>;
}

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: unknown, value: unknown): EqSentinel => ({
      __eq: { column: String((col as { name?: string })?.name ?? col), value },
    }),
    and: (...clauses: Array<EqSentinel | AndSentinel>): AndSentinel => ({
      __and: clauses,
    }),
  };
});

function flattenConditions(
  cond: EqSentinel | AndSentinel | undefined,
): Array<{ column: string; value: unknown }> {
  if (!cond) return [];
  if ('__eq' in cond) return [cond.__eq];
  return cond.__and.flatMap((c) => flattenConditions(c));
}

interface DbTable {
  name: string;
}

function tableName(t: unknown): string {
  // Drizzle pg tables expose a Symbol.for('drizzle:Name'), but we don't need
  // strictness here — the fake db only distinguishes between team_members
  // (for selects) and team_messages (for inserts) via the caller sequence.
  return (t as DbTable)?.name ?? 'unknown';
}

function makeFakeDb() {
  return {
    select(_cols?: unknown) {
      let mode: 'members' | 'agent_runs' | null = null;
      let filters: Array<{ column: string; value: unknown }> = [];
      const builder = {
        from(table: unknown) {
          // SendMessage queries team_members for recipient resolution and,
          // post-Phase-D, agent_runs for the wake-if-sleeping check. The
          // table-name shape varies across drizzle versions, so the resolver
          // disambiguates from the filter-value shape (see resolveRows).
          const name = tableName(table);
          if (name.includes('team_members') || true) {
            mode = 'members';
          }
          return builder;
        },
        where(cond: EqSentinel | AndSentinel) {
          filters = flattenConditions(cond);
          // Phase D: the agent_runs probe uses a `status='sleeping'` filter.
          // Detect it heuristically by sniffing for the literal among
          // filter values — team_members never carries 'sleeping' as a
          // column value, so this is collision-free.
          if (filters.some((f) => f.value === 'sleeping')) {
            mode = 'agent_runs';
          }
          // Make `where(...)` thenable so tests that fan out (broadcast)
          // can `await db.select(...).from(...).where(...)` without an
          // explicit `.limit()` and still receive every matching member.
          // We retain the chainable builder shape (with .limit) for the
          // recipient-resolution call sites.
          const thenableBuilder = builder as typeof builder & {
            then?: (
              onFulfilled: (rows: MemberRow[] | AgentRunRow[]) => unknown,
            ) => Promise<unknown>;
          };
          thenableBuilder.then = (
            onFulfilled: (rows: MemberRow[] | AgentRunRow[]) => unknown,
          ): Promise<unknown> => {
            const rows = resolveRows();
            return Promise.resolve(onFulfilled(rows));
          };
          return thenableBuilder;
        },
        limit(n: number): Promise<MemberRow[] | AgentRunRow[]> {
          if (mode === null) return Promise.resolve([]);
          const rows = resolveRows();
          return Promise.resolve(rows.slice(0, n));
        },
      };
      function resolveRows(): MemberRow[] | AgentRunRow[] {
        // The drizzle column object varies in shape across versions — we
        // take a shape-agnostic approach: collect all filter values and
        // filter the in-memory rows by "every filter matches at least
        // one of the row's known fields". Works because SendMessage only
        // composes eq() across a small fixed set of columns per table.
        const values = filters.map((f) => f.value);
        if (mode === 'agent_runs') {
          // Filter agent_runs by memberId + status (the only two columns
          // dispatchMessage's wake-if-sleeping probe constrains).
          return agentRunRows.filter((r) =>
            values.every((v) => v === r.memberId || v === r.status),
          );
        }
        // Default: team_members lookup. Phase C Task 5 returns the full
        // member row so column projections picking agentType / displayName
        // (peer-DM-shadow lookups) get real values.
        return members.filter((m) =>
          values.every(
            (v) => v === m.id || v === m.teamId || v === m.displayName,
          ),
        );
      }
      return builder;
    },
    insert(_table: unknown) {
      return {
        values(row: MessageRow) {
          inserts.push(row);
          return Promise.resolve();
        },
      };
    },
  };
}

const fakeDb = makeFakeDb();

// Fake Redis pubsub publisher recorder
const publishedRaw: Array<{ channel: string; message: string }> = [];
vi.mock('@/lib/redis', () => ({
  getPubSubPublisher: () => ({
    publish: async (channel: string, message: string) => {
      publishedRaw.push({ channel, message });
      return 1;
    },
  }),
}));

// We mock @/lib/db so the tool's default import path doesn't hit Postgres.
// The test always injects `db` via ctx.get, but the module still imports
// `db` top-level (which would trigger `postgres(...)` at import time).
vi.mock('@/lib/db', () => ({
  db: makeFakeDb(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Phase C: SendMessage shutdown_request + plan_approval_response call wake()
// on the recipient. We mock the wake helper so we can assert the call.
vi.mock('@/workers/processors/lib/wake', () => ({
  wake: vi.fn(async () => {}),
}));
import { wake } from '@/workers/processors/lib/wake';

// Phase C Task 5: peer-DM shadow needs the recipient's role, derived from
// AgentDefinition.role via resolveAgent(agentType). Tests stub the registry
// so role lookups are deterministic and don't touch disk.
vi.mock('@/tools/AgentTool/registry', () => ({
  resolveAgent: vi.fn(async (agentType: string) => {
    if (!agentType) return null;
    // Convention for these tests: agentType 'coordinator' is the lead;
    // every other agentType is a member. Real resolveAgent loads from
    // AGENT.md frontmatter.
    return {
      name: agentType,
      role: agentType === 'coordinator' ? 'lead' : 'member',
    };
  }),
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

import {
  sendMessageTool,
  SEND_MESSAGE_TOOL_NAME,
  teamMessagesChannel,
} from '../SendMessageTool';

function makeCtx(
  deps: Record<string, unknown>,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  const ac = new AbortController();
  return {
    abortSignal: overrides.abortSignal ?? ac.signal,
    get<V>(key: string): V {
      if (key in deps) return deps[key] as V;
      throw new Error(`no dep ${key}`);
    },
  };
}

beforeEach(() => {
  members.length = 0;
  inserts.length = 0;
  agentRunRows.length = 0;
  publishedRaw.length = 0;
  vi.mocked(wake).mockClear();
});

describe('SendMessage tool', () => {
  it('exports the canonical tool name', () => {
    expect(sendMessageTool.name).toBe(SEND_MESSAGE_TOOL_NAME);
    expect(SEND_MESSAGE_TOOL_NAME).toBe('SendMessage');
  });

  it('resolves a recipient by display_name and records + publishes the message', async () => {
    members.push({
      id: 'mem-alex',
      teamId: 'team-1',
      displayName: 'Alex',
    });

    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
      runId: 'run-1',
    });

    const result = await sendMessageTool.execute(
      { type: 'message', to: 'Alex', content: 'hi Alex' },
      ctx,
    );

    expect(result.delivered).toBe(true);
    expect(result.toMemberId).toBe('mem-alex');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].content).toBe('hi Alex');
    expect(inserts[0].fromMemberId).toBe('mem-sam');
    expect(inserts[0].toMemberId).toBe('mem-alex');
    expect(inserts[0].runId).toBe('run-1');
    expect(inserts[0].type).toBe('agent_text');

    expect(publishedRaw).toHaveLength(1);
    expect(publishedRaw[0].channel).toBe(teamMessagesChannel('team-1'));
    const payload = JSON.parse(publishedRaw[0].message);
    expect(payload.messageId).toBe(result.messageId);
    expect(payload.content).toBe('hi Alex');
  });

  it('errors when the display_name is not a team member', async () => {
    // No members seeded
    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
    });

    await expect(
      sendMessageTool.execute(
        { type: 'message', to: 'Ghost', content: 'hello?' },
        ctx,
      ),
    ).rejects.toThrow(/no team member named "Ghost"/);
    expect(inserts).toHaveLength(0);
    expect(publishedRaw).toHaveLength(0);
  });

  it('accepts a uuid-shaped `to` and resolves by id', async () => {
    const memberId = '11111111-2222-3333-4444-555555555555';
    members.push({ id: memberId, teamId: 'team-1', displayName: 'Alex' });

    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
    });

    const result = await sendMessageTool.execute(
      { type: 'message', to: memberId, content: 'hi' },
      ctx,
    );
    expect(result.toMemberId).toBe(memberId);
  });

  it('still returns success when Redis publish fails (DB insert is durable)', async () => {
    members.push({
      id: 'mem-alex',
      teamId: 'team-1',
      displayName: 'Alex',
    });
    // Swap the pubsub publisher to throw. vi.doMock would require a
    // re-import cycle; instead we reach into the module by re-mocking.
    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
    });

    // Monkey-patch the recorded publisher to throw on next call.
    // (Fresh publishedRaw already cleared in beforeEach.)
    // The tool catches errors at publishToRedis and logs a warning; the
    // happy-path assertions cover the non-throwing path.
    //
    // To simulate failure, replace the mock implementation per-call.
    const redis = await import('@/lib/redis');
    const spy = vi
      .spyOn(redis, 'getPubSubPublisher')
      .mockImplementation(() => ({
        publish: async () => {
          throw new Error('redis down');
        },
      }) as unknown as ReturnType<typeof redis.getPubSubPublisher>);

    const result = await sendMessageTool.execute(
      { type: 'message', to: 'Alex', content: 'hi' },
      ctx,
    );
    expect(result.delivered).toBe(true);
    expect(inserts).toHaveLength(1);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Phase C Task 2 — execute() variant dispatch
// ---------------------------------------------------------------------------
//
// Each variant inserts a different `team_messages` row shape. shutdown_request
// + plan_approval_response also call wake() on the recipient so the target
// processes the request promptly. shutdown_response + plan_approval_response
// chain the conversation thread via repliesToId.

describe('SendMessage execute() — variant dispatch', () => {
  it('type:message inserts a single team_messages row with messageType="message"', async () => {
    members.push({ id: 'mem-alex', teamId: 'team-1', displayName: 'Alex' });

    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
      runId: 'run-1',
    });

    const result = await sendMessageTool.execute(
      { type: 'message', to: 'Alex', content: 'hello' },
      ctx,
    );

    expect(result.delivered).toBe(true);
    expect(result.toMemberId).toBe('mem-alex');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].toMemberId).toBe('mem-alex');
    expect((inserts[0] as MessageRow & { messageType?: string }).messageType).toBe(
      'message',
    );
    // type:message does NOT wake — peer DMs are passive (lead receives shadow
    // without preemptive scheduling, target wakes via reconcile-mailbox cron
    // or its own poll).
    expect(vi.mocked(wake)).not.toHaveBeenCalled();
  });

  it('type:broadcast fans out to all team members except the sender', async () => {
    // 3 members on team-1; sender (mem-sam) excluded → 2 inserts.
    members.push({ id: 'mem-sam', teamId: 'team-1', displayName: 'Sam' });
    members.push({ id: 'mem-alex', teamId: 'team-1', displayName: 'Alex' });
    members.push({ id: 'mem-bea', teamId: 'team-1', displayName: 'Bea' });
    // Member on a different team must NOT receive the broadcast.
    members.push({ id: 'mem-other', teamId: 'team-other', displayName: 'Other' });

    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
      runId: 'run-1',
    });

    const result = await sendMessageTool.execute(
      { type: 'broadcast', content: 'Critical: stop all work' },
      ctx,
    );

    expect(result.delivered).toBe(true);
    expect(inserts).toHaveLength(2);
    const recipientIds = inserts.map((r) => r.toMemberId).sort();
    expect(recipientIds).toEqual(['mem-alex', 'mem-bea']);
    for (const row of inserts) {
      expect(
        (row as MessageRow & { messageType?: string }).messageType,
      ).toBe('broadcast');
      expect(row.fromMemberId).toBe('mem-sam');
      expect(row.content).toBe('Critical: stop all work');
    }
    // Result returns first messageId for compat — must be one of the inserted ids.
    expect(inserts.map((r) => r.id)).toContain(result.messageId);
  });

  it('type:shutdown_request inserts row with messageType="shutdown_request" and wakes target', async () => {
    members.push({ id: 'mem-alex', teamId: 'team-1', displayName: 'Alex' });

    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
      runId: 'run-1',
    });

    const result = await sendMessageTool.execute(
      { type: 'shutdown_request', to: 'Alex', content: 'wrap up' },
      ctx,
    );

    expect(result.delivered).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(
      (inserts[0] as MessageRow & { messageType?: string }).messageType,
    ).toBe('shutdown_request');
    expect(inserts[0].toMemberId).toBe('mem-alex');
    expect(inserts[0].content).toBe('wrap up');
    // Target must be woken so it processes the request promptly.
    expect(vi.mocked(wake)).toHaveBeenCalledOnce();
    expect(vi.mocked(wake)).toHaveBeenCalledWith('mem-alex');
  });

  it('type:shutdown_response inserts row with repliesToId and messageType="shutdown_response"', async () => {
    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-alex',
      runId: 'run-1',
    });

    const result = await sendMessageTool.execute(
      {
        type: 'shutdown_response',
        request_id: 'orig-msg-id',
        approve: false,
        content: 'need 5 more minutes',
      },
      ctx,
    );

    expect(result.delivered).toBe(true);
    expect(inserts).toHaveLength(1);
    const row = inserts[0] as MessageRow & {
      messageType?: string;
      repliesToId?: string | null;
    };
    expect(row.messageType).toBe('shutdown_response');
    expect(row.repliesToId).toBe('orig-msg-id');
    expect(row.content).toBe('need 5 more minutes');
    // shutdown_response does not wake the lead (lead picks up on next natural turn).
    expect(vi.mocked(wake)).not.toHaveBeenCalled();
  });

  it('type:plan_approval_response inserts row with repliesToId, toMemberId, and wakes target', async () => {
    members.push({ id: 'mem-alex', teamId: 'team-1', displayName: 'Alex' });

    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-lead',
      runId: 'run-1',
    });

    const result = await sendMessageTool.execute(
      {
        type: 'plan_approval_response',
        request_id: 'plan-msg-id',
        to: 'Alex',
        approve: true,
      },
      ctx,
    );

    expect(result.delivered).toBe(true);
    expect(inserts).toHaveLength(1);
    const row = inserts[0] as MessageRow & {
      messageType?: string;
      repliesToId?: string | null;
    };
    expect(row.messageType).toBe('plan_approval_response');
    expect(row.repliesToId).toBe('plan-msg-id');
    expect(row.toMemberId).toBe('mem-alex');
    // Approval must wake the teammate so it resumes promptly.
    expect(vi.mocked(wake)).toHaveBeenCalledOnce();
    expect(vi.mocked(wake)).toHaveBeenCalledWith('mem-alex');
  });

  // -------------------------------------------------------------------------
  // Phase D Task 6 — type:message wakes a sleeping recipient
  // -------------------------------------------------------------------------
  //
  // Phase C only woke targets on shutdown_request + plan_approval_response.
  // Phase D extends the plain `message` variant: if the recipient's
  // agent_runs row is in `status='sleeping'`, dispatchMessage must call
  // wake() so the teammate resumes its conversation. If the recipient is
  // already running (or has no agent_runs row at all), wake() must NOT
  // fire — wake on a running agent burns an idempotent enqueue but signals
  // wrong intent in the logs and risks racing the active loop.

  it('type:message wakes recipient when their agent_runs.status is sleeping (Phase D)', async () => {
    members.push({ id: 'mem-alex', teamId: 'team-1', displayName: 'Alex' });
    // Seed a sleeping agent_runs row for the recipient.
    agentRunRows.push({
      id: 'agent-run-alex',
      memberId: 'mem-alex',
      status: 'sleeping',
    });

    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
      runId: 'run-1',
    });

    const result = await sendMessageTool.execute(
      { type: 'message', to: 'Alex', content: 'wake up' },
      ctx,
    );

    expect(result.delivered).toBe(true);
    // Wake must fire with the agent_runs.id (not the memberId) so the
    // BullMQ payload routes to the correct sleeping agent.
    expect(vi.mocked(wake)).toHaveBeenCalledOnce();
    expect(vi.mocked(wake)).toHaveBeenCalledWith('agent-run-alex');
  });

  it('type:message does NOT wake recipient when their agent_runs.status is running (Phase D)', async () => {
    members.push({ id: 'mem-alex', teamId: 'team-1', displayName: 'Alex' });
    agentRunRows.push({
      id: 'agent-run-alex',
      memberId: 'mem-alex',
      status: 'running',
    });

    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
      runId: 'run-1',
    });

    const result = await sendMessageTool.execute(
      { type: 'message', to: 'Alex', content: 'fyi' },
      ctx,
    );

    expect(result.delivered).toBe(true);
    // No sleeping row → wake() must NOT fire.
    expect(vi.mocked(wake)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase C Task 3 — runtime validation (validateInput)
// ---------------------------------------------------------------------------
//
// Two architectural rules enforced at validateInput time (engine fail-closed
// pattern):
//   1. type:plan_approval_response is lead-only — caller's `callerRole` must
//      be 'lead', else 403.
//   2. type:broadcast is rate-limited to 1 per 5 seconds per sender — query
//      DB for prior broadcasts from same fromMemberId within the window;
//      if any found, return 429.
// Other variants pass through untouched (validateInput returns {result:true}).

describe('SendMessage validateInput — Phase C runtime checks', () => {
  // Track recent-broadcast lookups so we can simulate a prior broadcast row.
  // The fake db's broadcast-count helper reads this counter — simpler than
  // wiring a full SELECT-with-gt mock. Reset per-test in beforeEach below.
  let recentBroadcastCount = 0;

  // Replace the fakeDb's select to also model the
  // `SELECT id FROM team_messages WHERE messageType='broadcast' AND ...`
  // that countRecentBroadcasts issues. We detect it by checking whether the
  // filters reference 'broadcast' as a string value.
  function makeValidateDb(): typeof fakeDb {
    return {
      select(_cols?: unknown) {
        let mode: 'members' | 'broadcast_count' = 'members';
        let filters: Array<{ column: string; value: unknown }> = [];
        const builder = {
          from(_table: unknown) {
            return builder;
          },
          where(cond: unknown) {
            filters = flattenForValidate(cond);
            // Detect broadcast-count query by string-value 'broadcast' in filters.
            if (filters.some((f) => f.value === 'broadcast')) {
              mode = 'broadcast_count';
            }
            const thenableBuilder = builder as typeof builder & {
              then?: (
                onFulfilled: (rows: Array<{ id: string }>) => unknown,
              ) => Promise<unknown>;
            };
            thenableBuilder.then = (
              onFulfilled: (rows: Array<{ id: string }>) => unknown,
            ): Promise<unknown> => {
              const rows = resolveRows();
              return Promise.resolve(onFulfilled(rows));
            };
            return thenableBuilder;
          },
          limit(n: number): Promise<Array<{ id: string }>> {
            const rows = resolveRows();
            return Promise.resolve(rows.slice(0, n));
          },
        };
        function resolveRows(): Array<{ id: string }> {
          if (mode === 'broadcast_count') {
            return Array.from({ length: recentBroadcastCount }, (_, i) => ({
              id: `prior-${i}`,
            }));
          }
          const values = filters.map((f) => f.value);
          return members
            .filter((m) =>
              values.every(
                (v) => v === m.id || v === m.teamId || v === m.displayName,
              ),
            )
            .map((m) => ({ id: m.id }));
        }
        return builder;
      },
      insert(_table: unknown) {
        return {
          values(row: MessageRow) {
            inserts.push(row);
            return Promise.resolve();
          },
        };
      },
    } as unknown as typeof fakeDb;
  }
  function flattenForValidate(
    cond: unknown,
  ): Array<{ column: string; value: unknown }> {
    if (!cond || typeof cond !== 'object') return [];
    if ('__eq' in cond) {
      const eqCond = cond as { __eq: { column: string; value: unknown } };
      return [eqCond.__eq];
    }
    if ('__and' in cond) {
      const andCond = cond as { __and: unknown[] };
      return andCond.__and.flatMap((c) => flattenForValidate(c));
    }
    // gt() returns a different sentinel — capture column+value if shaped.
    if ('__gt' in cond) {
      const gtCond = cond as { __gt: { column: string; value: unknown } };
      return [gtCond.__gt];
    }
    return [];
  }

  beforeEach(() => {
    recentBroadcastCount = 0;
  });

  it('rejects plan_approval_response when caller is not lead (403)', async () => {
    const ctx = makeCtx({
      db: makeValidateDb(),
      teamId: 'team-1',
      currentMemberId: 'mem-member',
      callerRole: 'member',
    });
    const validate = sendMessageTool.validateInput;
    expect(validate).toBeDefined();
    const result = await validate!(
      {
        type: 'plan_approval_response',
        request_id: 'plan-1',
        to: 'Alex',
        approve: true,
      },
      ctx,
    );
    expect(result.result).toBe(false);
    if (!result.result) {
      expect(result.errorCode).toBe(403);
      expect(result.message).toMatch(/lead/i);
    }
  });

  it('accepts plan_approval_response when caller is lead', async () => {
    const ctx = makeCtx({
      db: makeValidateDb(),
      teamId: 'team-1',
      currentMemberId: 'mem-lead',
      callerRole: 'lead',
    });
    const result = await sendMessageTool.validateInput!(
      {
        type: 'plan_approval_response',
        request_id: 'plan-1',
        to: 'Alex',
        approve: true,
      },
      ctx,
    );
    expect(result.result).toBe(true);
  });

  it('rejects broadcast when caller already broadcast in last 5s (429)', async () => {
    recentBroadcastCount = 1;
    const ctx = makeCtx({
      db: makeValidateDb(),
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
      callerRole: 'member',
    });
    const result = await sendMessageTool.validateInput!(
      { type: 'broadcast', content: 'second broadcast in 5s' },
      ctx,
    );
    expect(result.result).toBe(false);
    if (!result.result) {
      expect(result.errorCode).toBe(429);
      expect(result.message).toMatch(/rate.?limit/i);
    }
  });

  it('accepts broadcast when no recent broadcasts', async () => {
    recentBroadcastCount = 0;
    const ctx = makeCtx({
      db: makeValidateDb(),
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
      callerRole: 'member',
    });
    const result = await sendMessageTool.validateInput!(
      { type: 'broadcast', content: 'first broadcast' },
      ctx,
    );
    expect(result.result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase C Task 5 — peer-DM shadow on teammate↔teammate messages
// ---------------------------------------------------------------------------
//
// When a teammate sends `type:message` to another teammate (NOT to the lead),
// dispatchMessage MUST also insert a peer-DM-shadow row to the lead's mailbox
// (engine PDF §3.6.1 channel ③ — low-cost transparency, NEVER calls wake on
// the lead). When the recipient is the lead, no shadow is needed because the
// lead is already the direct recipient.
//
// Phase B kludge: leadAgentId is null in Phase B (the lead has no agent_runs
// row yet) — the helper handles null gracefully and skips the insert. These
// tests inject a synthetic leadAgentId via the ctx so the shadow row is
// observable without waiting for Phase E.

describe('SendMessage execute() — peer-DM shadow (Phase C Task 5)', () => {
  it('teammate→teammate message also inserts a peer-DM shadow (2 inserts)', async () => {
    // Sender (Sam) and recipient (Alex) are both teammates (agentType !==
    // coordinator). Lead has a synthetic agent_runs.id injected via ctx.
    members.push({
      id: 'mem-sam',
      teamId: 'team-1',
      displayName: 'Sam',
      agentType: 'content-manager',
    });
    members.push({
      id: 'mem-alex',
      teamId: 'team-1',
      displayName: 'Alex',
      agentType: 'discovery-agent',
    });

    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
      callerRole: 'member',
      leadAgentId: 'lead-agent-run-1',
      runId: 'run-1',
    });

    const result = await sendMessageTool.execute(
      { type: 'message', to: 'Alex', content: 'hey', summary: 'asking q' },
      ctx,
    );

    expect(result.delivered).toBe(true);
    expect(inserts).toHaveLength(2);
    // First insert is the primary message → mem-alex.
    expect(inserts[0].toMemberId).toBe('mem-alex');
    expect(inserts[0].content).toBe('hey');
    // Second insert is the shadow → lead's agent_runs.id with <peer-dm> body.
    const shadow = inserts[1] as MessageRow & {
      toAgentId?: string;
      messageType?: string;
    };
    expect(shadow.toAgentId).toBe('lead-agent-run-1');
    expect(shadow.messageType).toBe('message');
    expect(shadow.content).toContain('<peer-dm');
    expect(shadow.content).toContain('Sam');
    expect(shadow.content).toContain('Alex');
    expect(shadow.content).toContain('asking q');
    // CRITICAL invariant: shadow MUST NOT call wake() on the lead.
    expect(vi.mocked(wake)).not.toHaveBeenCalled();
  });

  it('teammate→lead message inserts only the primary row (no shadow)', async () => {
    // Recipient is the lead (agentType: coordinator). Lead is already the
    // direct recipient — shadowing would be redundant.
    members.push({
      id: 'mem-sam',
      teamId: 'team-1',
      displayName: 'Sam',
      agentType: 'content-manager',
    });
    members.push({
      id: 'mem-lead',
      teamId: 'team-1',
      displayName: 'Lead',
      agentType: 'coordinator',
    });

    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
      callerRole: 'member',
      leadAgentId: 'lead-agent-run-1',
      runId: 'run-1',
    });

    const result = await sendMessageTool.execute(
      { type: 'message', to: 'Lead', content: 'status update' },
      ctx,
    );

    expect(result.delivered).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].toMemberId).toBe('mem-lead');
    expect(vi.mocked(wake)).not.toHaveBeenCalled();
  });
});
