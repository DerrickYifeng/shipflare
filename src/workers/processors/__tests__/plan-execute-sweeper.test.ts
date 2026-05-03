/**
 * plan-execute-sweeper Phase J Task 2 batch coverage.
 *
 * The sweeper is now responsible for two paths:
 *
 *   1. content_post draft batching — pulls due content_post + planned +
 *      approve rows, atomically claims them (planned → drafting), and
 *      dispatches ONE content-manager(post_batch) team-run per
 *      (userId, productId).
 *
 *   2. The legacy per-row plan-execute enqueue path for every other
 *      (kind, phase) combination, which we keep covered indirectly
 *      via plan-execute.test.ts.
 *
 * This test focuses on path 1 — the new batch dispatch — to lock in:
 *   - rows actually flip planned → drafting (claim is atomic)
 *   - drafted/skipped rows are NOT touched
 *   - exactly ONE team-run is enqueued for the user, with `Mode:
 *     post_batch` + the claimed planItemIds in the goal
 *   - the legacy per-row enqueue is NOT also fired for the same rows
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

// ---------------------------------------------------------------------------
// Mock harness
// ---------------------------------------------------------------------------

interface PlanItemRow {
  id: string;
  userId: string;
  productId: string;
  kind: string;
  state: string;
  userAction: string;
  channel: string | null;
  scheduledAt: Date;
  [key: string]: unknown;
}
interface TeamRow {
  id: string;
  userId: string;
  productId: string;
  [key: string]: unknown;
}
interface MemberRow {
  id: string;
  teamId: string;
  agentType: string;
  [key: string]: unknown;
}

const planItemRows: PlanItemRow[] = [];
const teamRows: TeamRow[] = [];
const teamMemberRows: MemberRow[] = [];

// Each table is a tagged proxy. Accessing `planItems.id` returns
// `{ _col: 'id', _table: 'plan_items' }`; the in-memory db mock keys
// off `_table` to figure out which table to read/write.
function tableProxy(name: string): Record<string, { _col: string; _table: string }> & {
  _table: string;
} {
  return new Proxy(
    { _table: name },
    {
      get: (target, prop: string) => {
        if (prop === '_table') return target._table;
        return { _col: prop, _table: name };
      },
    },
  ) as Record<string, { _col: string; _table: string }> & { _table: string };
}

const PLAN_ITEMS_PROXY = tableProxy('plan_items');
const TEAMS_PROXY = tableProxy('teams');
const TEAM_MEMBERS_PROXY = tableProxy('team_members');

vi.mock('@/lib/db/schema', () => ({
  planItems: PLAN_ITEMS_PROXY,
  teams: TEAMS_PROXY,
  teamMembers: TEAM_MEMBERS_PROXY,
}));

// drizzle-orm mocks. We model the operators as opaque sentinels and
// dispatch on their `.kind` so the in-memory builder can interpret
// which rows match.
interface FilterSentinel {
  kind: string;
  // The sentinel carries enough info to evaluate it against a row.
  match: (row: Record<string, unknown>) => boolean;
}

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');

  function colName(col: unknown): string | null {
    if (col && typeof col === 'object' && '_col' in col) {
      return (col as { _col: string })._col;
    }
    return null;
  }

  return {
    ...actual,
    eq: (col: unknown, value: unknown): FilterSentinel => {
      const name = colName(col);
      return {
        kind: 'eq',
        match: (row) => (name ? row[name] === value : true),
      };
    },
    inArray: (col: unknown, values: unknown[]): FilterSentinel => {
      const name = colName(col);
      return {
        kind: 'inArray',
        match: (row) => (name ? values.includes(row[name]) : true),
      };
    },
    lte: (col: unknown, value: Date): FilterSentinel => {
      const name = colName(col);
      return {
        kind: 'lte',
        match: (row) => {
          if (!name) return false;
          const v = row[name];
          if (v instanceof Date && value instanceof Date)
            return v.getTime() <= value.getTime();
          return false;
        },
      };
    },
    and: (...parts: FilterSentinel[]): FilterSentinel => ({
      kind: 'and',
      match: (row) => parts.every((p) => p.match(row)),
    }),
    or: (...parts: FilterSentinel[]): FilterSentinel => ({
      kind: 'or',
      match: (row) => parts.some((p) => p.match(row)),
    }),
    sql: Object.assign(() => 'sql-token', { raw: () => 'sql-token' }),
  };
});

vi.mock('@/lib/db', () => {
  function tableName(table: unknown): string | null {
    if (table && typeof table === 'object' && '_table' in table) {
      return (table as { _table: string })._table;
    }
    return null;
  }

  function tableRows(table: unknown): Record<string, unknown>[] {
    const name = tableName(table);
    if (name === 'plan_items') return planItemRows as Record<string, unknown>[];
    if (name === 'teams') return teamRows as Record<string, unknown>[];
    if (name === 'team_members') return teamMemberRows as Record<string, unknown>[];
    return [];
  }

  function selectFrom(table: unknown) {
    return {
      where: (cond: FilterSentinel) => {
        const filtered = tableRows(table).filter((r) => cond.match(r));
        return {
          limit: (n: number) => Promise.resolve(filtered.slice(0, n)),
        };
      },
    };
  }

  function update(table: unknown) {
    return {
      set: (patch: Record<string, unknown>) => ({
        where: (cond: FilterSentinel) => {
          const list = tableRows(table);
          // Drop drizzle's `sql\`now()\`` token from the patch — the
          // in-memory mock doesn't model timestamps.
          const cleanPatch: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(patch)) {
            if (k === 'updatedAt') continue;
            cleanPatch[k] = v;
          }
          const updated: Array<{ id: unknown }> = [];
          for (let i = 0; i < list.length; i += 1) {
            if (cond.match(list[i])) {
              list[i] = { ...list[i], ...cleanPatch };
              updated.push({ id: list[i].id });
            }
          }
          return {
            returning: (_cols?: unknown) => Promise.resolve(updated),
          };
        },
      }),
    };
  }

  return {
    db: {
      select: () => ({ from: (table: unknown) => selectFrom(table) }),
      update: (table: unknown) => update(table),
    },
  };
});

// Pipeline events / logger / queue helpers.
vi.mock('@/lib/pipeline-events', () => ({
  recordPipelineEventsBulk: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
  loggerForJob: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

const enqueuePlanExecuteMock = vi.fn(async (_data: unknown) => 'job-id');
vi.mock('@/lib/queue/plan-execute', () => ({
  enqueuePlanExecute: (data: unknown) => enqueuePlanExecuteMock(data),
}));

// Phase E Task 11: replaced enqueueTeamRun with spawnMemberAgentRun. The
// helper inserts an agent_runs row + initial mailbox message for the
// content-manager directly (mirrors Task tool's launchAsyncTeammate
// shape); the test only cares that it was called with the right input,
// so we mock the whole helper.
const spawnMemberAgentRunMock = vi.fn(async (input: Record<string, unknown>) => ({
  agentId: 'agent-batch-1',
  messageId: 'msg-batch-1',
  __input: input,
}));
vi.mock('@/lib/team/spawn-member-agent-run', () => ({
  spawnMemberAgentRun: (input: Record<string, unknown>) =>
    spawnMemberAgentRunMock(input),
}));

vi.mock('@/lib/team-conversation-helpers', () => ({
  createAutomationConversation: vi.fn().mockResolvedValue('conv-batch-1'),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function seedTeam(userId: string, productId: string): {
  teamId: string;
  contentManagerId: string;
} {
  const teamId = `team-${userId}-${productId}`;
  teamRows.push({ id: teamId, userId, productId });
  const cmId = `mem-${teamId}-content-manager`;
  teamMemberRows.push({ id: cmId, teamId, agentType: 'content-manager' });
  return { teamId, contentManagerId: cmId };
}

function seedPlanItem(init: Partial<PlanItemRow> & { id: string }): void {
  planItemRows.push({
    userId: 'u-1',
    productId: 'p-1',
    kind: 'content_post',
    state: 'planned',
    userAction: 'approve',
    channel: 'x',
    scheduledAt: new Date('2026-04-30T00:00:00Z'),
    ...init,
  });
}

function makeJob(): Job<Record<string, never>> {
  return { id: 'sweep-1', data: {} } as Job<Record<string, never>>;
}

beforeEach(() => {
  planItemRows.length = 0;
  teamRows.length = 0;
  teamMemberRows.length = 0;
  enqueuePlanExecuteMock.mockClear();
  spawnMemberAgentRunMock.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('plan-execute-sweeper — content_post batch dispatch', () => {
  it('claims due content_post rows and spawns ONE content-manager agent_run with post_batch goal', async () => {
    const { contentManagerId, teamId } = seedTeam('u-1', 'p-1');
    seedPlanItem({ id: 'pi-1' });
    seedPlanItem({ id: 'pi-2' });
    // Already-drafted row should be ignored — sweeper only claims `planned`.
    seedPlanItem({ id: 'pi-3', state: 'drafted' });

    const { processPlanExecuteSweeper } = await import(
      '../plan-execute-sweeper'
    );
    await processPlanExecuteSweeper(makeJob());

    // 1. Exactly one content-manager agent_run spawned (no per-row enqueue).
    expect(spawnMemberAgentRunMock).toHaveBeenCalledTimes(1);
    expect(enqueuePlanExecuteMock).not.toHaveBeenCalled();

    // 2. Prompt carries Mode: post_batch + both due plan_item ids.
    const call = spawnMemberAgentRunMock.mock.calls[0]?.[0] as {
      teamId: string;
      trigger: string;
      memberId: string;
      agentDefName: string;
      prompt: string;
      conversationId: string;
    };
    expect(call.teamId).toBe(teamId);
    expect(call.trigger).toBe('draft_post');
    expect(call.memberId).toBe(contentManagerId);
    expect(call.agentDefName).toBe('content-manager');
    expect(call.conversationId).toBe('conv-batch-1');
    expect(call.prompt).toContain('Mode: post_batch');
    expect(call.prompt).toContain('"pi-1"');
    expect(call.prompt).toContain('"pi-2"');
    expect(call.prompt).not.toContain('"pi-3"');

    // 3. Claimed rows are now in `drafting`. Untouched row stays `drafted`.
    expect(planItemRows.find((r) => r.id === 'pi-1')!.state).toBe('drafting');
    expect(planItemRows.find((r) => r.id === 'pi-2')!.state).toBe('drafting');
    expect(planItemRows.find((r) => r.id === 'pi-3')!.state).toBe('drafted');
  });

  it('groups by (userId, productId) — two users get two agent_runs', async () => {
    seedTeam('u-1', 'p-1');
    seedTeam('u-2', 'p-2');
    seedPlanItem({ id: 'a-1', userId: 'u-1', productId: 'p-1' });
    seedPlanItem({ id: 'b-1', userId: 'u-2', productId: 'p-2' });

    const { processPlanExecuteSweeper } = await import(
      '../plan-execute-sweeper'
    );
    await processPlanExecuteSweeper(makeJob());

    expect(spawnMemberAgentRunMock).toHaveBeenCalledTimes(2);
  });

  it('is idempotent — a re-run after the first claim dispatches nothing for the same rows', async () => {
    seedTeam('u-1', 'p-1');
    seedPlanItem({ id: 'pi-A' });
    seedPlanItem({ id: 'pi-B' });

    const { processPlanExecuteSweeper } = await import(
      '../plan-execute-sweeper'
    );
    await processPlanExecuteSweeper(makeJob());
    expect(spawnMemberAgentRunMock).toHaveBeenCalledTimes(1);

    spawnMemberAgentRunMock.mockClear();
    await processPlanExecuteSweeper(makeJob());
    // Second sweep — both rows are now in `drafting`, so the candidate
    // query returns nothing and no agent_run is spawned.
    expect(spawnMemberAgentRunMock).not.toHaveBeenCalled();
  });

  it('skips dispatch when the team has no content-manager (older default-squad)', async () => {
    // Team without a content-manager — only baseline coordinator.
    const teamId = 'team-old';
    teamRows.push({ id: teamId, userId: 'u-1', productId: 'p-1' });
    teamMemberRows.push({
      id: 'mem-c',
      teamId,
      agentType: 'coordinator',
    });
    seedPlanItem({ id: 'pi-orphan' });

    const { processPlanExecuteSweeper } = await import(
      '../plan-execute-sweeper'
    );
    await processPlanExecuteSweeper(makeJob());

    expect(spawnMemberAgentRunMock).not.toHaveBeenCalled();
    // Row is left in `planned` so a future tick (after content-manager
    // is provisioned) can still pick it up.
    expect(planItemRows.find((r) => r.id === 'pi-orphan')!.state).toBe(
      'planned',
    );
  });

  it('does NOT batch content_post rows that are scheduled in the future', async () => {
    seedTeam('u-1', 'p-1');
    seedPlanItem({
      id: 'pi-future',
      scheduledAt: new Date('3000-01-01T00:00:00Z'),
    });

    const { processPlanExecuteSweeper } = await import(
      '../plan-execute-sweeper'
    );
    await processPlanExecuteSweeper(makeJob());

    expect(spawnMemberAgentRunMock).not.toHaveBeenCalled();
    expect(planItemRows.find((r) => r.id === 'pi-future')!.state).toBe(
      'planned',
    );
  });

  it('does NOT short-circuit other-kind rows — content_reply still flows through per-row enqueue', async () => {
    seedTeam('u-1', 'p-1');
    seedPlanItem({ id: 'pi-reply', kind: 'content_reply', channel: 'x' });

    const { processPlanExecuteSweeper } = await import(
      '../plan-execute-sweeper'
    );
    await processPlanExecuteSweeper(makeJob());

    // No team-run from the batch path (kind != content_post).
    expect(spawnMemberAgentRunMock).not.toHaveBeenCalled();
    // Per-row enqueue runs as before for content_reply + planned + approve.
    expect(enqueuePlanExecuteMock).toHaveBeenCalledTimes(1);
    const call = enqueuePlanExecuteMock.mock.calls[0]?.[0] as {
      planItemId: string;
      phase: string;
    };
    expect(call.planItemId).toBe('pi-reply');
    expect(call.phase).toBe('draft');
  });
});
