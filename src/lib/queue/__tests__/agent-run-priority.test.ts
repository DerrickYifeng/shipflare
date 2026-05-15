// B6: agent-run priority lanes — queue name registry + routing tests.
//
// The producer side is the contract: `enqueueAgentRun` MUST land the
// job in the right BullMQ queue (priority / standard / backfill) based
// on `opts.priority`. We mock the bullmq Queue constructor so the test
// is hermetic — no Redis required — and assert which Queue instance's
// `.add()` was called.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — hoisted via vi.hoisted so they're in scope for vi.mock factories
// ---------------------------------------------------------------------------

// Per-instance add() spies, keyed by the queue name. The Queue mock
// builds a fresh object with its own add() spy on every construction so
// we can assert which lane each enqueue landed on.
const queuesByName = vi.hoisted(
  () => new Map<string, { add: ReturnType<typeof vi.fn> }>(),
);

vi.mock('bullmq', () => {
  class FakeQueue {
    readonly name: string;
    readonly add: ReturnType<typeof vi.fn>;
    constructor(name: string) {
      this.name = name;
      this.add = vi.fn(async (_jobName: string, data: unknown, opts?: unknown) => ({
        id: `job-${name}-${Math.random().toString(36).slice(2, 8)}`,
        data,
        opts,
      }));
      queuesByName.set(name, { add: this.add });
    }
  }
  return { Queue: FakeQueue };
});

vi.mock('@/lib/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset the per-queue add() counters; the Queue mock is constructed
  // once at module-load (when agent-run.ts is first imported), so the
  // handles persist across `it` blocks — we only need to clear call
  // history between tests.
  for (const handle of queuesByName.values()) {
    handle.add.mockClear();
  }
});

describe('AGENT_RUN_QUEUE_NAMES', () => {
  it('defines priority, standard, backfill lane names', async () => {
    const { AGENT_RUN_QUEUE_NAMES } = await import('../agent-run');
    expect(AGENT_RUN_QUEUE_NAMES).toEqual({
      priority: 'agent-run-priority',
      standard: 'agent-run',
      backfill: 'agent-run-backfill',
    });
  });

  it('keeps the legacy AGENT_RUN_QUEUE_NAME pointed at the standard lane', async () => {
    const { AGENT_RUN_QUEUE_NAME, AGENT_RUN_QUEUE_NAMES } = await import(
      '../agent-run'
    );
    // Drain-compat: existing in-flight jobs queued under the old
    // 'agent-run' name MUST land on the new standard worker on deploy.
    expect(AGENT_RUN_QUEUE_NAME).toBe('agent-run');
    expect(AGENT_RUN_QUEUE_NAME).toBe(AGENT_RUN_QUEUE_NAMES.standard);
  });
});

describe('laneFromQueueName', () => {
  it('maps the three BullMQ queue names back to their lane keys', async () => {
    const { laneFromQueueName } = await import('../agent-run');
    expect(laneFromQueueName('agent-run-priority')).toBe('priority');
    expect(laneFromQueueName('agent-run')).toBe('standard');
    expect(laneFromQueueName('agent-run-backfill')).toBe('backfill');
  });

  it("falls back to 'standard' on unknown queue names", async () => {
    const { laneFromQueueName } = await import('../agent-run');
    expect(laneFromQueueName('not-a-real-queue')).toBe('standard');
    expect(laneFromQueueName('')).toBe('standard');
  });
});

describe('enqueueAgentRun — lane routing', () => {
  it("routes to the priority queue when priority='priority'", async () => {
    const { enqueueAgentRun } = await import('../agent-run');
    await enqueueAgentRun({ agentId: 'a1' }, { priority: 'priority' });

    const pri = queuesByName.get('agent-run-priority');
    const std = queuesByName.get('agent-run');
    const back = queuesByName.get('agent-run-backfill');
    expect(pri?.add).toHaveBeenCalledTimes(1);
    expect(std?.add).not.toHaveBeenCalled();
    expect(back?.add).not.toHaveBeenCalled();
  });

  it("routes to the standard queue when priority='standard'", async () => {
    const { enqueueAgentRun } = await import('../agent-run');
    await enqueueAgentRun({ agentId: 'a2' }, { priority: 'standard' });

    const pri = queuesByName.get('agent-run-priority');
    const std = queuesByName.get('agent-run');
    const back = queuesByName.get('agent-run-backfill');
    expect(pri?.add).not.toHaveBeenCalled();
    expect(std?.add).toHaveBeenCalledTimes(1);
    expect(back?.add).not.toHaveBeenCalled();
  });

  it("routes to the backfill queue when priority='backfill'", async () => {
    const { enqueueAgentRun } = await import('../agent-run');
    await enqueueAgentRun({ agentId: 'a3' }, { priority: 'backfill' });

    const pri = queuesByName.get('agent-run-priority');
    const std = queuesByName.get('agent-run');
    const back = queuesByName.get('agent-run-backfill');
    expect(pri?.add).not.toHaveBeenCalled();
    expect(std?.add).not.toHaveBeenCalled();
    expect(back?.add).toHaveBeenCalledTimes(1);
  });

  it("defaults to the standard queue when priority is omitted", async () => {
    const { enqueueAgentRun } = await import('../agent-run');
    await enqueueAgentRun({ agentId: 'a4' });

    const std = queuesByName.get('agent-run');
    expect(std?.add).toHaveBeenCalledTimes(1);
  });

  it('passes through jobId + delay to BullMQ.add', async () => {
    const { enqueueAgentRun } = await import('../agent-run');
    await enqueueAgentRun(
      { agentId: 'a5' },
      { priority: 'priority', jobId: 'custom:a5:42', delay: 1234 },
    );

    const pri = queuesByName.get('agent-run-priority');
    expect(pri?.add).toHaveBeenCalledWith(
      'run',
      { agentId: 'a5' },
      expect.objectContaining({ jobId: 'custom:a5:42', delay: 1234 }),
    );
  });
});

describe('reenqueueWithDelay — lane routing', () => {
  it("routes to the same lane as the caller's priority arg", async () => {
    const { reenqueueWithDelay } = await import('../agent-run');

    await reenqueueWithDelay('a6', 1500, 'priority');
    await reenqueueWithDelay('a7', 1500, 'backfill');
    await reenqueueWithDelay('a8', 1500, 'standard');

    expect(queuesByName.get('agent-run-priority')?.add).toHaveBeenCalledTimes(
      1,
    );
    expect(queuesByName.get('agent-run-backfill')?.add).toHaveBeenCalledTimes(
      1,
    );
    expect(queuesByName.get('agent-run')?.add).toHaveBeenCalledTimes(1);
  });

  it("defaults to 'standard' when priority is omitted", async () => {
    const { reenqueueWithDelay } = await import('../agent-run');

    await reenqueueWithDelay('a9', 1500);

    expect(queuesByName.get('agent-run')?.add).toHaveBeenCalledTimes(1);
    expect(queuesByName.get('agent-run-priority')?.add).not.toHaveBeenCalled();
    expect(queuesByName.get('agent-run-backfill')?.add).not.toHaveBeenCalled();
  });

  it('uses the documented delayed-job id shape + adds jitter to delay', async () => {
    const { reenqueueWithDelay } = await import('../agent-run');

    await reenqueueWithDelay('a10', 1000, 'priority');

    const pri = queuesByName.get('agent-run-priority');
    const call = pri?.add.mock.calls[0];
    expect(call).toBeDefined();
    const [_jobName, _data, opts] = call as [
      string,
      unknown,
      { jobId: string; delay: number },
    ];
    expect(opts.jobId).toMatch(/^delayed:a10:\d+$/);
    // jitter range is [0, 500) so delay ∈ [1000, 1500)
    expect(opts.delay).toBeGreaterThanOrEqual(1000);
    expect(opts.delay).toBeLessThan(1500);
  });
});
