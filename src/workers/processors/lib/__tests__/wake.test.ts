import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wake } from '@/workers/processors/lib/wake';

// Mock the queue helper that wake() depends on. The typed `opts` signature
// includes B6's `priority` field so the lane-propagation tests below can
// assert against it without `any` casts.
vi.mock('@/lib/queue/agent-run', () => ({
  AGENT_RUN_QUEUE_NAME: 'agent-run',
  enqueueAgentRun: vi.fn(
    async (
      data: { agentId: string },
      opts?: {
        jobId?: string;
        priority?: 'priority' | 'standard' | 'backfill';
      },
    ) => ({
      id: opts?.jobId ?? 'generated-id',
      data,
    }),
  ),
}));

import { enqueueAgentRun } from '@/lib/queue/agent-run';

describe('wake(agentId)', () => {
  beforeEach(() => {
    vi.mocked(enqueueAgentRun).mockClear();
  });

  it('enqueues an agent-run job with the given agentId', async () => {
    await wake('agent-123');
    expect(enqueueAgentRun).toHaveBeenCalledOnce();
    const call = vi.mocked(enqueueAgentRun).mock.calls[0];
    expect(call[0]).toEqual({ agentId: 'agent-123' });
  });

  it('uses agentId as the BullMQ jobId for dedupe', async () => {
    await wake('agent-456');
    const call = vi.mocked(enqueueAgentRun).mock.calls[0];
    // Per BullMQ docs, jobs with the same jobId are deduplicated within
    // the queue's lifetime — preventing duplicate wakes from racing
    // SendMessage callers in Phase C.
    expect(call[1]?.jobId).toMatch(/agent-456/);
  });

  // -------------------------------------------------------------------
  // B6: lane propagation. The lane contract is also covered at the
  // `enqueueAgentRun` layer in `src/lib/queue/__tests__/agent-run-priority.test.ts`,
  // but these tests pin it at the wake() boundary — the actual API that
  // every founder/teammate/cron call-site uses.
  // -------------------------------------------------------------------

  it('defaults to standard lane when priority not specified', async () => {
    await wake('agent-default');
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      { agentId: 'agent-default' },
      expect.objectContaining({ priority: 'standard' }),
    );
  });

  it('forwards priority lane to enqueueAgentRun', async () => {
    await wake('agent-priority', 'priority');
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      { agentId: 'agent-priority' },
      expect.objectContaining({ priority: 'priority' }),
    );
  });

  it('forwards backfill lane to enqueueAgentRun', async () => {
    await wake('agent-backfill', 'backfill');
    expect(enqueueAgentRun).toHaveBeenCalledWith(
      { agentId: 'agent-backfill' },
      expect.objectContaining({ priority: 'backfill' }),
    );
  });
});
