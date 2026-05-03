/**
 * TaskStop tool unit tests — Phase C Task 6.
 *
 * The `TaskStop` tool is the lead's "graceful stop" lever for a teammate:
 *   1. INSERT a `shutdown_request` row addressed to the teammate's
 *      `agent_runs.id` (the teammate's mailbox drain picks it up at the
 *      next idle turn and exits cleanly — graceful shutdown).
 *   2. UPDATE `agent_runs.status='killed'` with `shutdownReason`.
 *   3. WAKE the target so it processes the shutdown promptly (rather than
 *      idling until the reconcile-mailbox cron tick).
 *
 * Architectural rule: lead-only. Teammates cannot stop peers — that
 * authority lives strictly with the team-lead. Enforced via
 * `validateInput` reading `callerRole` from the ToolContext (engine
 * fail-closed: missing key => 403).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolContext } from '@/core/types';

// ---------------------------------------------------------------------------
// In-memory recorders for INSERT / UPDATE assertions
// ---------------------------------------------------------------------------

interface InsertedRow {
  teamId: string;
  type: string;
  messageType: string;
  fromMemberId: string | null;
  toAgentId: string | null;
  content: string | null;
  summary: string | null;
}

interface UpdateCall {
  values: Record<string, unknown>;
  whereValue: unknown;
}

const inserts: InsertedRow[] = [];
const updates: UpdateCall[] = [];

// ---------------------------------------------------------------------------
// drizzle-orm mock — emit sentinels we can decode in the fake db
// ---------------------------------------------------------------------------

interface EqSentinel {
  __eq: { column: string; value: unknown };
}

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: unknown, value: unknown): EqSentinel => ({
      __eq: { column: String((col as { name?: string })?.name ?? col), value },
    }),
  };
});

function makeFakeDb() {
  return {
    insert(_table: unknown) {
      return {
        values(row: InsertedRow): Promise<void> {
          inserts.push(row);
          return Promise.resolve();
        },
      };
    },
    update(_table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(cond: EqSentinel): Promise<void> {
              updates.push({ values, whereValue: cond.__eq?.value });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
}

const fakeDb = makeFakeDb();

// Default db import must not hit Postgres at module load.
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

// wake() must be mocked so we can assert TaskStop wakes the target.
vi.mock('@/workers/processors/lib/wake', () => ({
  wake: vi.fn(async () => {}),
}));
import { wake } from '@/workers/processors/lib/wake';

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

import {
  taskStopTool,
  TASK_STOP_TOOL_NAME,
} from '../TaskStopTool';

function makeCtx(deps: Record<string, unknown>): ToolContext {
  const ac = new AbortController();
  return {
    abortSignal: ac.signal,
    get<V>(key: string): V {
      if (key in deps) return deps[key] as V;
      throw new Error(`no dep ${key}`);
    },
  };
}

function makeLeadCtx(extra: Record<string, unknown> = {}): ToolContext {
  return makeCtx({
    db: fakeDb,
    teamId: 'team-1',
    currentMemberId: 'mem-lead',
    callerRole: 'lead',
    ...extra,
  });
}

function makeMemberCtx(extra: Record<string, unknown> = {}): ToolContext {
  return makeCtx({
    db: fakeDb,
    teamId: 'team-1',
    currentMemberId: 'mem-member',
    callerRole: 'member',
    ...extra,
  });
}

beforeEach(() => {
  inserts.length = 0;
  updates.length = 0;
  vi.mocked(wake).mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskStop tool — Phase C', () => {
  it('exports the canonical tool name', () => {
    expect(taskStopTool.name).toBe(TASK_STOP_TOOL_NAME);
    expect(TASK_STOP_TOOL_NAME).toBe('TaskStop');
  });

  it('inserts shutdown_request row for the target agentId', async () => {
    const ctx = makeLeadCtx();
    await taskStopTool.execute({ task_id: 'agent-target' }, ctx);

    expect(inserts).toHaveLength(1);
    const row = inserts[0];
    expect(row.messageType).toBe('shutdown_request');
    expect(row.toAgentId).toBe('agent-target');
    expect(row.teamId).toBe('team-1');
    expect(row.type).toBe('user_prompt');
    expect(row.fromMemberId).toBe('mem-lead');
    expect(row.content).toBeTruthy();
  });

  it('calls wake on the target so it processes shutdown_request promptly', async () => {
    const ctx = makeLeadCtx();
    await taskStopTool.execute({ task_id: 'agent-target' }, ctx);

    expect(vi.mocked(wake)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(wake)).toHaveBeenCalledWith('agent-target');
  });

  it('updates agent_runs.status to "killed" with shutdownReason', async () => {
    const ctx = makeLeadCtx();
    await taskStopTool.execute({ task_id: 'agent-target' }, ctx);

    // At least one UPDATE call sets status='killed' and a shutdownReason
    // for the target agent_runs.id.
    const killedUpdate = updates.find(
      (u) => u.values.status === 'killed' && u.whereValue === 'agent-target',
    );
    expect(killedUpdate).toBeDefined();
    expect(killedUpdate!.values.shutdownReason).toBeTruthy();
  });

  it('rejects when caller is not lead (403)', async () => {
    const ctx = makeMemberCtx();

    expect(taskStopTool.validateInput).toBeDefined();
    const result = await taskStopTool.validateInput!(
      { task_id: 'agent-target' },
      ctx,
    );

    expect(result.result).toBe(false);
    if (!result.result) {
      expect(result.errorCode).toBe(403);
      expect(result.message).toMatch(/lead/i);
    }
  });
});
