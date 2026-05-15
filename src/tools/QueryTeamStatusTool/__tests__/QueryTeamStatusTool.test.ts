/**
 * query_team_status unit tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolContext } from '@/core/types';
import {
  createInMemoryStore,
  drizzleMockFactory,
  type InMemoryStore,
} from '@/lib/test-utils/in-memory-db';

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return drizzleMockFactory(actual as unknown as Record<string, unknown>);
});
vi.mock('@/lib/db', () => ({ db: createInMemoryStore().db }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { queryTeamStatusTool } from '../QueryTeamStatusTool';
import { agentRuns, teamMembers } from '@/lib/db/schema';

interface MemberRow {
  id: string;
  teamId: string;
  agentType: string;
  displayName: string;
  status: string;
  lastActiveAt: Date | null;
}
interface AgentRunRow {
  id: string;
  teamId: string;
  memberId: string;
  agentDefName: string;
  parentAgentId: string | null;
  parentToolUseId: string | null;
  status: string;
  spawnedAt: Date;
  lastActiveAt: Date;
}

function makeCtx(store: InMemoryStore, deps: Record<string, unknown>): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      if (key in deps) return deps[key] as V;
      if (key === 'db') return store.db as unknown as V;
      throw new Error(`no dep ${key}`);
    },
  };
}

let store: InMemoryStore;
beforeEach(() => {
  store = createInMemoryStore();
});

describe('queryTeamStatusTool', () => {
  it('returns members for the caller\'s team only', async () => {
    store.register<MemberRow>(teamMembers, [
      {
        id: 'm-1',
        teamId: 'team-1',
        agentType: 'coordinator',
        displayName: 'Sam',
        status: 'idle',
        lastActiveAt: null,
      },
      {
        id: 'm-2',
        teamId: 'team-1',
        agentType: 'growth-strategist',
        displayName: 'Alex',
        status: 'active',
        lastActiveAt: new Date('2026-04-20T12:00:00Z'),
      },
      {
        id: 'm-other',
        teamId: 'team-other',
        agentType: 'coordinator',
        displayName: 'Ghost',
        status: 'idle',
        lastActiveAt: null,
      },
    ]);
    store.register<AgentRunRow>(agentRuns, []);

    const ctx = makeCtx(store, { teamId: 'team-1' });
    const rows = await queryTeamStatusTool.execute({}, ctx);
    expect(rows.map((r) => r.memberId).sort()).toEqual(['m-1', 'm-2']);
    const alex = rows.find((r) => r.memberId === 'm-2')!;
    expect(alex.agent_type).toBe('growth-strategist');
    expect(alex.display_name).toBe('Alex');
    expect(alex.status).toBe('active');
    expect(alex.last_active_at).toBe('2026-04-20T12:00:00.000Z');
  });

  it('attaches currentTask when the member has an in-flight agent_run', async () => {
    store.register<MemberRow>(teamMembers, [
      {
        id: 'm-busy',
        teamId: 'team-1',
        agentType: 'content-planner',
        displayName: 'Charlie',
        status: 'active',
        lastActiveAt: new Date(),
      },
    ]);
    const start = new Date('2026-04-20T10:00:00Z');
    store.register<AgentRunRow>(agentRuns, [
      {
        id: 'a-done',
        teamId: 'team-1',
        memberId: 'm-busy',
        agentDefName: 'content-planner',
        parentAgentId: null,
        parentToolUseId: null,
        status: 'completed',
        spawnedAt: new Date('2026-04-19T10:00:00Z'),
        lastActiveAt: new Date('2026-04-19T10:30:00Z'),
      },
      {
        id: 'a-running',
        teamId: 'team-1',
        memberId: 'm-busy',
        agentDefName: 'content-planner',
        parentAgentId: null,
        parentToolUseId: null,
        status: 'running',
        spawnedAt: start,
        lastActiveAt: start,
      },
    ]);

    const ctx = makeCtx(store, { teamId: 'team-1' });
    const rows = await queryTeamStatusTool.execute({}, ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0].currentTask).toEqual({
      description: 'content-planner',
      startedAt: start.toISOString(),
    });
  });

  it('rejects unexpected input keys via strict schema', () => {
    const parse = queryTeamStatusTool.inputSchema.safeParse({ foo: 1 });
    expect(parse.success).toBe(false);
  });
});
