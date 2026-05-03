import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

// Three select chains fan out from POST (in implementation order):
//   (1) ownership lookup        — fields include `prompt` + `taskStatus`
//   (2) team_members list       — fields include `agentType` + `id` only
//   (3) primary conversation    — fields include `id` only (single field)
// The mock dispatches on field-shape so the test isn't coupled to call order.

type TaskRow = {
  taskId: string;
  teamId: string;
  prompt: string;
  description: string;
  input: Record<string, unknown>;
  taskStatus: string;
};
type MemberRow = { id: string; agentType: string };
type ConvRow = { id: string };

let taskRows: TaskRow[] = [];
let memberRows: MemberRow[] = [];
let convRows: ConvRow[] = [];
let insertedConv: { teamId: string; title: string | null } | null = null;

vi.mock('@/lib/db', () => ({
  db: {
    select: (projection: Record<string, unknown>) => {
      const fields = Object.keys(projection);
      const isTask = fields.includes('prompt') && fields.includes('taskStatus');
      const isMembers =
        fields.length === 2 &&
        fields.includes('id') &&
        fields.includes('agentType');
      const isConv = fields.length === 1 && fields.includes('id');

      if (isTask) {
        return {
          from: () => ({
            innerJoin: () => ({
              innerJoin: () => ({
                where: () => ({
                  limit: () => Promise.resolve(taskRows),
                }),
              }),
            }),
          }),
        };
      }
      if (isMembers) {
        return {
          from: () => ({
            where: () => Promise.resolve(memberRows),
          }),
        };
      }
      if (isConv) {
        return {
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => Promise.resolve(convRows),
              }),
            }),
          }),
        };
      }
      return {
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => ({ limit: () => Promise.resolve([]) }),
            }),
          }),
          where: () => Promise.resolve([]),
        }),
      };
    },
    insert: () => ({
      values: (vals: { teamId: string; title: string | null }) => ({
        returning: () => {
          insertedConv = vals;
          return Promise.resolve([{ id: 'conv-new' }]);
        },
      }),
    }),
  },
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
  return {
    ...actual,
    eq: () => ({}),
    and: () => ({}),
    desc: () => ({}),
  };
});

type SpawnArgs = [Record<string, unknown>, unknown];
const spawnSpy = vi.fn<(...args: SpawnArgs) => Promise<{ agentId: string; messageId: string }>>(
  async () => Promise.resolve({ agentId: 'agent-1', messageId: 'msg-1' }),
);
vi.mock('@/lib/team/spawn-member-agent-run', () => ({
  spawnMemberAgentRun: (...args: SpawnArgs) => spawnSpy(...args),
}));

import { POST } from '../route';

beforeEach(() => {
  authUserId = 'user-1';
  taskRows = [];
  memberRows = [];
  convRows = [];
  insertedConv = null;
  spawnSpy.mockClear();
});

function makeReq(): NextRequest {
  return new NextRequest('http://test/api/team/task/task-1/retry', {
    method: 'POST',
  });
}

async function call(taskId: string): Promise<Response> {
  return POST(makeReq(), { params: Promise.resolve({ taskId }) });
}

describe('POST /api/team/task/[taskId]/retry', () => {
  it('rejects unauthorized callers', async () => {
    authUserId = null;
    const res = await call('task-1');
    expect(res.status).toBe(401);
  });

  it('returns 404 when ownership chain fails (no row)', async () => {
    taskRows = [];
    const res = await call('task-1');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('task_not_found');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('returns 409 when task is still running (not retryable)', async () => {
    taskRows = [
      {
        taskId: 'task-1',
        teamId: 'team-1',
        prompt: 'Do the thing',
        description: 'thing',
        input: { subagent_type: 'coordinator' },
        taskStatus: 'running',
      },
    ];
    memberRows = [{ id: 'm-1', agentType: 'coordinator' }];
    const res = await call('task-1');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('not_retryable');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('spawns retry against existing primary conversation', async () => {
    taskRows = [
      {
        taskId: 'task-1',
        teamId: 'team-1',
        prompt: 'Do the thing',
        description: 'thing',
        input: { subagent_type: 'coordinator' },
        taskStatus: 'failed',
      },
    ];
    memberRows = [{ id: 'm-1', agentType: 'coordinator' }];
    convRows = [{ id: 'conv-existing' }];

    const res = await call('task-1');
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({
      taskId: 'task-1',
      runId: 'agent-1',
      conversationId: 'conv-existing',
    });
    expect(spawnSpy).toHaveBeenCalledOnce();
    const firstCall = spawnSpy.mock.calls[0];
    if (!firstCall) throw new Error('spawnSpy not called');
    const [args] = firstCall;
    expect(args).toMatchObject({
      teamId: 'team-1',
      memberId: 'm-1',
      agentDefName: 'coordinator',
      conversationId: 'conv-existing',
      trigger: 'task_retry',
    });
    expect(insertedConv).toBeNull();
  });

  it('mints a fresh conversation when team has none', async () => {
    taskRows = [
      {
        taskId: 'task-1',
        teamId: 'team-1',
        prompt: 'Do the thing',
        description: 'thing',
        input: { subagent_type: 'coordinator' },
        taskStatus: 'failed',
      },
    ];
    memberRows = [{ id: 'm-1', agentType: 'coordinator' }];
    convRows = [];

    const res = await call('task-1');
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.conversationId).toBe('conv-new');
    expect(insertedConv).toMatchObject({ teamId: 'team-1' });
  });

  it('falls back to coordinator when subagent_type is unknown', async () => {
    taskRows = [
      {
        taskId: 'task-1',
        teamId: 'team-1',
        prompt: 'Do the thing',
        description: 'thing',
        input: { subagent_type: 'phantom-agent' },
        taskStatus: 'failed',
      },
    ];
    memberRows = [
      { id: 'm-1', agentType: 'coordinator' },
      { id: 'm-2', agentType: 'content-planner' },
    ];
    convRows = [{ id: 'conv-existing' }];

    const res = await call('task-1');
    expect(res.status).toBe(202);
    const firstCall = spawnSpy.mock.calls[0];
    if (!firstCall) throw new Error('spawnSpy not called');
    const [args] = firstCall;
    expect(args.memberId).toBe('m-1');
    expect(args.agentDefName).toBe('coordinator');
  });
});
