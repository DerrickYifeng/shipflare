import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

type TaskRow = {
  taskId: string;
  runId: string;
  teamId: string;
  taskStatus: string;
  input: Record<string, unknown>;
  ownerId: string;
};

let taskRows: TaskRow[] = [];
const updateCalls: { setArg: Record<string, unknown> }[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve(taskRows),
            }),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (setArg: Record<string, unknown>) => {
        updateCalls.push({ setArg });
        return {
          where: () => Promise.resolve(),
        };
      },
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
    inArray: () => ({}),
    not: () => ({}),
  };
});

const publishSpy = vi.fn<(channel: string, payload: string) => Promise<number>>(
  async () => Promise.resolve(1),
);
vi.mock('@/lib/redis', () => ({
  getPubSubPublisher: () => ({ publish: publishSpy }),
}));

vi.mock('@/tools/SendMessageTool/SendMessageTool', () => ({
  teamMessagesChannel: (teamId: string) => `team:${teamId}:messages`,
}));

import { POST } from '../route';

beforeEach(() => {
  authUserId = 'user-1';
  taskRows = [];
  updateCalls.length = 0;
  publishSpy.mockClear();
});

function makeReq(): NextRequest {
  return new NextRequest('http://test/api/team/task/task-1/cancel', {
    method: 'POST',
  });
}

async function call(taskId: string): Promise<Response> {
  return POST(makeReq(), { params: Promise.resolve({ taskId }) });
}

describe('POST /api/team/task/[taskId]/cancel', () => {
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
    expect(updateCalls.length).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('returns 200 alreadyTerminal when task is already cancelled', async () => {
    taskRows = [
      {
        taskId: 'task-1',
        runId: 'run-1',
        teamId: 'team-1',
        taskStatus: 'cancelled',
        input: {},
        ownerId: 'user-1',
      },
    ];
    const res = await call('task-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      taskId: 'task-1',
      status: 'cancelled',
      alreadyTerminal: true,
    });
    expect(updateCalls.length).toBe(0);
  });

  it('cancels a running task and publishes synthetic tool_result', async () => {
    taskRows = [
      {
        taskId: 'task-1',
        runId: 'run-1',
        teamId: 'team-1',
        taskStatus: 'running',
        input: { toolUseId: 'toolu_abc' },
        ownerId: 'user-1',
      },
    ];

    const res = await call('task-1');
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ taskId: 'task-1', status: 'cancelled' });

    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].setArg.status).toBe('cancelled');
    expect(updateCalls[0].setArg.completedAt).toBeInstanceOf(Date);

    expect(publishSpy).toHaveBeenCalledOnce();
    const firstCall = publishSpy.mock.calls[0];
    if (!firstCall) throw new Error('publishSpy not called');
    const [channel, payloadStr] = firstCall;
    expect(channel).toBe('team:team-1:messages');
    const payload = JSON.parse(payloadStr);
    expect(payload).toMatchObject({
      runId: 'run-1',
      teamId: 'team-1',
      type: 'tool_result',
      metadata: { toolUseId: 'toolu_abc', isError: true, cancelled: true },
    });
  });

  it('cancels without publishing when input has no toolUseId', async () => {
    taskRows = [
      {
        taskId: 'task-1',
        runId: 'run-1',
        teamId: 'team-1',
        taskStatus: 'running',
        input: {},
        ownerId: 'user-1',
      },
    ];

    const res = await call('task-1');
    expect(res.status).toBe(202);
    expect(updateCalls.length).toBe(1);
    expect(publishSpy).not.toHaveBeenCalled();
  });
});
