/**
 * Phase G cleanup (migration 0016_drop_team_runs): the team_runs table
 * is gone and `getTeamBudgetSnapshot` / `teamHasBudgetRemaining` /
 * `maybeEmitBudgetWarning` are now no-op stubs that report 0 spend and
 * "always has budget". The pure helpers (`weekStartUtc`,
 * `isAutoBudgetPauseEnabled`) keep their behavioural tests; the
 * cost-tracking tests are retired with a TODO pointing at the future
 * agent_runs.totalTokens-based reimplementation. See module header in
 * `src/lib/team-budget.ts` and git history of this file for the legacy
 * cost-tracking fixtures.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  weekStartUtc,
  DEFAULT_WEEKLY_BUDGET_USD,
  isAutoBudgetPauseEnabled,
} from '@/lib/team-budget';

// ---------------------------------------------------------------------------
// weekStartUtc — pure fn (unchanged)
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
// isAutoBudgetPauseEnabled — env flag (unchanged)
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
// Stubbed cost-tracking helpers — confirm Phase G shape
//
// TODO(perf-cleanup-2026-XX): when cost tracking is rebuilt on
// `agent_runs.totalTokens × model rate`, restore the legacy spend tests
// (sum across the week, exhaustion threshold, 90% warning dedupe). See
// git history of this file for the fixtures.
// ---------------------------------------------------------------------------

interface TeamRow {
  id: string;
  config: Record<string, unknown>;
}

const hoisted = vi.hoisted(() => {
  const teamsTable: symbol = Symbol('teams');
  const teamRowsStore: unknown[] = [];
  return { teamsTable, teamRowsStore };
});
const { teamsTable, teamRowsStore } = hoisted;

const getTeamRows = (): TeamRow[] => teamRowsStore as TeamRow[];

function resetTables() {
  teamRowsStore.length = 0;
}

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => ({ __eq: { col, value } }),
  };
});

vi.mock('@/lib/db/schema', () => ({
  teams: hoisted.teamsTable,
}));

vi.mock('@/lib/db', () => {
  interface EqSentinel {
    __eq: { col: unknown; value: unknown };
  }

  function selectForTable(_cols: Record<string, unknown>) {
    return {
      from: (table: symbol) => ({
        where: (cond: unknown) => {
          if (table === teamsTable) {
            const c = cond as EqSentinel;
            const value = c?.__eq?.value;
            const matched = (teamRowsStore as TeamRow[]).filter(
              (r) => r.id === value,
            );
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

describe('getTeamBudgetSnapshot (Phase G stub)', () => {
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

  it('always reports zero spend (Phase G stub)', async () => {
    getTeamRows().push({ id: 't-1', config: { weeklyBudgetUsd: 10 } });
    const { getTeamBudgetSnapshot } = await import('@/lib/team-budget');
    const snap = await getTeamBudgetSnapshot('t-1');
    expect(snap.spentUsd).toBe(0);
    expect(snap.utilization).toBe(0);
    expect(snap.exhausted).toBe(false);
    expect(snap.at90Percent).toBe(false);
  });
});

describe('teamHasBudgetRemaining (Phase G stub)', () => {
  beforeEach(() => resetTables());

  it('always returns true (cost tracking dormant until perf-cleanup-2026-XX)', async () => {
    getTeamRows().push({ id: 't-1', config: { weeklyBudgetUsd: 1 } });
    const { teamHasBudgetRemaining } = await import('@/lib/team-budget');
    expect(await teamHasBudgetRemaining('t-1')).toBe(true);
  });
});

describe('maybeEmitBudgetWarning (Phase G stub)', () => {
  beforeEach(() => resetTables());

  it('never invokes the sink because the stub snapshot reports 0 spend', async () => {
    getTeamRows().push({ id: 't-1', config: { weeklyBudgetUsd: 5 } });
    const sink = vi.fn(async () => {});
    const dedupe = vi.fn(async () => true);
    const { maybeEmitBudgetWarning } = await import('@/lib/team-budget');
    await maybeEmitBudgetWarning('t-1', undefined, sink, dedupe);
    expect(sink).not.toHaveBeenCalled();
  });
});
