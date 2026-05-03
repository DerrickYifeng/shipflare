import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/queue/agent-run', () => ({
  enqueueAgentRun: vi.fn(async () => ({ id: 'job-1' })),
}));

// Default db import must not hit Postgres at module load — every test
// passes its own fake via ctx.get('db').
vi.mock('@/lib/db', () => ({
  db: {},
}));

import { sleepTool, SLEEP_TOOL_NAME } from '@/tools/SleepTool/SleepTool';
import { enqueueAgentRun } from '@/lib/queue/agent-run';
import type { ToolContext } from '@/core/types';

interface UpdateCall {
  values: Record<string, unknown>;
}

function makeFakeDb(updates: UpdateCall[]) {
  return {
    update(_table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(_cond: unknown): Promise<void> {
              updates.push({ values });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
}

function makeAgentCtx(over: { agentId?: string; updates?: UpdateCall[] } = {}): ToolContext {
  const updates = over.updates ?? [];
  const fakeDb = makeFakeDb(updates);
  return {
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      if (key === 'callerAgentId') return (over.agentId ?? 'agent-self') as V;
      if (key === 'db') return fakeDb as V;
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
    const result = await sleepTool.execute({ duration_ms: 30_000 }, makeAgentCtx());
    expect(result.slept).toBe(true);
    expect(result.agentId).toBe('agent-self');
    expect(result.durationMs).toBe(30_000);
    expect(result.wakeAt).toBeInstanceOf(Date);
  });

  it('marks agent_runs status=sleeping with sleepUntil', async () => {
    const updates: UpdateCall[] = [];
    await sleepTool.execute({ duration_ms: 60_000 }, makeAgentCtx({ updates }));
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toMatchObject({
      status: 'sleeping',
      sleepUntil: expect.any(Date),
    });
  });

  it('schedules delayed BullMQ job via enqueueAgentRun', async () => {
    await sleepTool.execute({ duration_ms: 5_000 }, makeAgentCtx({ agentId: 'a-1' }));
    expect(enqueueAgentRun).toHaveBeenCalledOnce();
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      { agentId: 'a-1' },
      expect.objectContaining({ delay: 5_000 }),
    );
  });

  it('rejects duration_ms > 24h (24*3600*1000 = 86_400_000)', async () => {
    await expect(
      sleepTool.execute({ duration_ms: 86_400_001 }, makeAgentCtx()),
    ).rejects.toThrow(/24/i);
  });

  it('rejects duration_ms <= 0', async () => {
    await expect(
      sleepTool.execute({ duration_ms: 0 }, makeAgentCtx()),
    ).rejects.toThrow(/positive/i);
  });
});
