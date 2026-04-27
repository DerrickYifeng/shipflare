import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  weekStartUtc,
  DEFAULT_WEEKLY_BUDGET_USD,
  isAutoBudgetPauseEnabled,
} from '@/lib/team-budget';

// ---------------------------------------------------------------------------
// weekStartUtc — pure fn
// ---------------------------------------------------------------------------

describe('weekStartUtc', () => {
  it('rolls back Tuesday 2026-04-21T14:00:00Z to 2026-04-20T00:00:00Z', () => {
    const start = weekStartUtc(new Date('2026-04-21T14:00:00Z'));
    expect(start.toISOString()).toBe('2026-04-20T00:00:00.000Z');
  });

  it('leaves Monday 00:00:00 UTC unchanged', () => {
    const start = weekStartUtc(new Date('2026-04-20T00:00:00Z'));
    expect(start.toISOString()).toBe('2026-04-20T00:00:00.000Z');
  });

  it('rolls back Sunday to the preceding Monday', () => {
    // 2026-04-26 is a Sunday.
    const start = weekStartUtc(new Date('2026-04-26T23:30:00Z'));
    expect(start.toISOString()).toBe('2026-04-20T00:00:00.000Z');
  });

  it('handles month boundaries', () => {
    // 2026-05-02 is a Saturday — rolls back to 2026-04-27 (Mon).
    const start = weekStartUtc(new Date('2026-05-02T09:00:00Z'));
    expect(start.toISOString()).toBe('2026-04-27T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// isAutoBudgetPauseEnabled — env flag
// ---------------------------------------------------------------------------

describe('isAutoBudgetPauseEnabled', () => {
  const originalEnv = process.env.SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE;
    } else {
      process.env.SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE = originalEnv;
    }
  });

  it('defaults to true when unset', () => {
    delete process.env.SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE;
    expect(isAutoBudgetPauseEnabled()).toBe(true);
  });

  it('is false when env=false', () => {
    process.env.SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE = 'false';
    expect(isAutoBudgetPauseEnabled()).toBe(false);
  });

  it('is false when env=0', () => {
    process.env.SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE = '0';
    expect(isAutoBudgetPauseEnabled()).toBe(false);
  });

  it('is true for any other value', () => {
    process.env.SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE = 'true';
    expect(isAutoBudgetPauseEnabled()).toBe(true);
    process.env.SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE = 'yes';
    expect(isAutoBudgetPauseEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getTeamBudgetSnapshot + teamHasBudgetRemaining + maybeEmitBudgetWarning
//
// In-memory db mock — covers the tiny surface these helpers use.
// ---------------------------------------------------------------------------

interface TeamRow {
  id: string;
  config: Record<string, unknown>;
}
interface RunRow {
  id: string;
  teamId: string;
  totalCostUsd: string | null;
  startedAt: Date;
}

// `vi.mock` factories are hoisted above top-level const declarations; use
// `vi.hoisted` so the table symbols + row arrays are available when the
// factory runs. See https://vitest.dev/api/vi.html#vi-hoisted.
const hoisted = vi.hoisted(() => {
  const teamsTable: symbol = Symbol('teams');
  const teamRunsTable: symbol = Symbol('teamRuns');
  const teamRowsStore: unknown[] = [];
  const runRowsStore: unknown[] = [];
  return { teamsTable, teamRunsTable, teamRowsStore, runRowsStore };
});
const { teamsTable, teamRunsTable, teamRowsStore, runRowsStore } = hoisted;

const getTeamRows = (): TeamRow[] => teamRowsStore as TeamRow[];
const getRunRows = (): RunRow[] => runRowsStore as RunRow[];

function resetTables() {
  teamRowsStore.length = 0;
  runRowsStore.length = 0;
}

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  function makeSqlFragment(marker: string) {
    return {
      __sql: marker,
      as: (alias: string) => ({ __sqlAlias: alias, marker }),
    };
  }
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => ({ __eq: { col, value } }),
    gte: (col: unknown, value: unknown) => ({ __gte: { col, value } }),
    and: (...parts: unknown[]) => ({ __and: parts }),
    sql: Object.assign(
      (strings: TemplateStringsArray, ..._values: unknown[]) =>
        makeSqlFragment(strings.join('?')),
      { raw: () => makeSqlFragment('raw') },
    ),
  };
});

vi.mock('@/lib/db/schema', () => ({
  teams: hoisted.teamsTable,
  teamRuns: hoisted.teamRunsTable,
}));

vi.mock('@/lib/db', () => {
  interface EqSentinel { __eq: { col: unknown; value: unknown } }
  interface GteSentinel { __gte: { col: unknown; value: unknown } }
  interface AndSentinel { __and: unknown[] }
  type Filter = EqSentinel | GteSentinel | AndSentinel;

  function flatten(cond: unknown): Array<{ op: string; value: unknown }> {
    if (!cond) return [];
    const c = cond as Filter;
    if ('__and' in c) return c.__and.flatMap((x) => flatten(x));
    if ('__eq' in c) return [{ op: 'eq', value: c.__eq.value }];
    if ('__gte' in c) return [{ op: 'gte', value: c.__gte.value }];
    return [];
  }

  function matchesTeam(row: TeamRow, f: Array<{ op: string; value: unknown }>): boolean {
    return f.every(({ op, value }) => {
      if (op === 'eq') return row.id === value;
      return true;
    });
  }

  function matchesRun(row: RunRow, f: Array<{ op: string; value: unknown }>): boolean {
    return f.every(({ op, value }) => {
      if (op === 'eq') return row.teamId === value;
      if (op === 'gte') return row.startedAt.getTime() >= (value as Date).getTime();
      return true;
    });
  }

  function selectForTable(cols: Record<string, unknown>) {
    return {
      from: (table: symbol) => ({
        where: (cond: unknown) => {
          const f = flatten(cond);
          if (table === hoisted.teamsTable) {
            const matched = (hoisted.teamRowsStore as TeamRow[]).filter((r) =>
              matchesTeam(r, f),
            );
            return {
              limit: (n: number) => Promise.resolve(matched.slice(0, n)),
              then: (cb: (v: unknown) => unknown) =>
                Promise.resolve(matched).then(cb),
            };
          }
          if (table === hoisted.teamRunsTable) {
            const matched = (hoisted.runRowsStore as RunRow[]).filter((r) =>
              matchesRun(r, f),
            );
            // getTeamBudgetSnapshot asks for sum(total_cost_usd).
            if ('sum' in cols) {
              const total = matched.reduce(
                (acc: number, r: RunRow) =>
                  acc + Number(r.totalCostUsd ?? 0),
                0,
              );
              return Promise.resolve([{ sum: String(total) }]);
            }
            return {
              limit: (n: number) => Promise.resolve(matched.slice(0, n)),
              then: (cb: (v: unknown) => unknown) =>
                Promise.resolve(matched).then(cb),
            };
          }
          return Promise.resolve([]);
        },
      }),
    };
  }

  return {
    db: {
      select: (cols: Record<string, unknown>) => selectForTable(cols),
    },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

describe('getTeamBudgetSnapshot', () => {
  beforeEach(() => resetTables());

  it('uses DEFAULT_WEEKLY_BUDGET_USD when teams.config.weeklyBudgetUsd is absent', async () => {
    getTeamRows().push({ id: 't-1', config: {} });
    const { getTeamBudgetSnapshot } = await import('@/lib/team-budget');
    const snap = await getTeamBudgetSnapshot('t-1');
    expect(snap.weeklyBudgetUsd).toBe(DEFAULT_WEEKLY_BUDGET_USD);
    expect(snap.spentUsd).toBe(0);
    expect(snap.exhausted).toBe(false);
    expect(snap.at90Percent).toBe(false);
  });

  it('honors custom weeklyBudgetUsd from teams.config', async () => {
    getTeamRows().push({
      id: 't-1',
      config: { weeklyBudgetUsd: 20 },
    });
    const { getTeamBudgetSnapshot } = await import('@/lib/team-budget');
    const snap = await getTeamBudgetSnapshot('t-1');
    expect(snap.weeklyBudgetUsd).toBe(20);
  });

  it('sums team_runs.total_cost_usd since the current Monday', async () => {
    getTeamRows().push({ id: 't-1', config: { weeklyBudgetUsd: 10 } });
    // Pick a fixed "now" (Tuesday) and seed runs before/after the week start.
    const now = new Date('2026-04-21T14:00:00Z'); // Tuesday
    getRunRows().push({
      id: 'r-old',
      teamId: 't-1',
      totalCostUsd: '100', // should NOT count — before monday 2026-04-20
      startedAt: new Date('2026-04-13T10:00:00Z'),
    });
    getRunRows().push({
      id: 'r-new-1',
      teamId: 't-1',
      totalCostUsd: '2.50',
      startedAt: new Date('2026-04-20T08:00:00Z'), // monday this week
    });
    getRunRows().push({
      id: 'r-new-2',
      teamId: 't-1',
      totalCostUsd: '1.75',
      startedAt: new Date('2026-04-21T09:00:00Z'),
    });
    const { getTeamBudgetSnapshot } = await import('@/lib/team-budget');
    const snap = await getTeamBudgetSnapshot('t-1', undefined, now);
    expect(snap.spentUsd).toBeCloseTo(4.25, 2);
    expect(snap.exhausted).toBe(false);
    expect(snap.at90Percent).toBe(false);
  });

  it('flags exhausted + at90Percent correctly', async () => {
    getTeamRows().push({ id: 't-1', config: { weeklyBudgetUsd: 5 } });
    const now = new Date('2026-04-21T14:00:00Z');
    getRunRows().push({
      id: 'r-1',
      teamId: 't-1',
      totalCostUsd: '4.60', // 92% — at90Percent but not exhausted
      startedAt: new Date('2026-04-20T08:00:00Z'),
    });
    const { getTeamBudgetSnapshot } = await import('@/lib/team-budget');
    const snap = await getTeamBudgetSnapshot('t-1', undefined, now);
    expect(snap.at90Percent).toBe(true);
    expect(snap.exhausted).toBe(false);

    // Push over 100%.
    getRunRows().push({
      id: 'r-2',
      teamId: 't-1',
      totalCostUsd: '1.00',
      startedAt: new Date('2026-04-21T08:00:00Z'),
    });
    const snap2 = await getTeamBudgetSnapshot('t-1', undefined, now);
    expect(snap2.exhausted).toBe(true);
  });
});

describe('teamHasBudgetRemaining', () => {
  const originalEnv = process.env.SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE;

  beforeEach(() => {
    resetTables();
    delete process.env.SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE;
    } else {
      process.env.SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE = originalEnv;
    }
  });

  it('returns true when budget remains', async () => {
    getTeamRows().push({ id: 't-1', config: { weeklyBudgetUsd: 10 } });
    const { teamHasBudgetRemaining } = await import('@/lib/team-budget');
    expect(await teamHasBudgetRemaining('t-1')).toBe(true);
  });

  it('returns false when budget is exhausted', async () => {
    getTeamRows().push({ id: 't-1', config: { weeklyBudgetUsd: 1 } });
    // Today's spend exceeds budget.
    const today = new Date();
    getRunRows().push({
      id: 'r-1',
      teamId: 't-1',
      totalCostUsd: '5.00',
      startedAt: today,
    });
    const { teamHasBudgetRemaining } = await import('@/lib/team-budget');
    expect(await teamHasBudgetRemaining('t-1')).toBe(false);
  });

  it('always returns true when feature flag is disabled', async () => {
    process.env.SHIPFLARE_TEAM_AUTO_BUDGET_PAUSE = 'false';
    getTeamRows().push({ id: 't-1', config: { weeklyBudgetUsd: 1 } });
    getRunRows().push({
      id: 'r-1',
      teamId: 't-1',
      totalCostUsd: '5.00',
      startedAt: new Date(),
    });
    const { teamHasBudgetRemaining } = await import('@/lib/team-budget');
    expect(await teamHasBudgetRemaining('t-1')).toBe(true);
  });
});

describe('maybeEmitBudgetWarning', () => {
  beforeEach(() => resetTables());

  it('calls sink once when over 90%, and dedupes on second call', async () => {
    getTeamRows().push({ id: 't-1', config: { weeklyBudgetUsd: 5 } });
    const now = new Date('2026-04-21T14:00:00Z');
    getRunRows().push({
      id: 'r-1',
      teamId: 't-1',
      totalCostUsd: '4.80', // 96%
      startedAt: new Date('2026-04-20T08:00:00Z'),
    });

    const sink = vi.fn(async () => {});
    const dedupeState = new Set<string>();
    const dedupe = vi.fn(async (teamId: string, week: Date) => {
      const key = `${teamId}:${week.toISOString()}`;
      if (dedupeState.has(key)) return false;
      dedupeState.add(key);
      return true;
    });

    const { maybeEmitBudgetWarning } = await import('@/lib/team-budget');
    await maybeEmitBudgetWarning('t-1', undefined, sink, dedupe, now);
    expect(sink).toHaveBeenCalledTimes(1);

    await maybeEmitBudgetWarning('t-1', undefined, sink, dedupe, now);
    expect(sink).toHaveBeenCalledTimes(1); // dedupe held
  });

  it('does not call sink below 90%', async () => {
    getTeamRows().push({ id: 't-1', config: { weeklyBudgetUsd: 5 } });
    const now = new Date('2026-04-21T14:00:00Z');
    getRunRows().push({
      id: 'r-1',
      teamId: 't-1',
      totalCostUsd: '2.00', // 40%
      startedAt: new Date('2026-04-20T08:00:00Z'),
    });
    const sink = vi.fn(async () => {});
    const dedupe = vi.fn(async () => true);
    const { maybeEmitBudgetWarning } = await import('@/lib/team-budget');
    await maybeEmitBudgetWarning('t-1', undefined, sink, dedupe, now);
    expect(sink).not.toHaveBeenCalled();
  });
});
