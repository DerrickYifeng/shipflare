import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wake } from '@/workers/processors/lib/wake';

// Mock the queue helper that wake() depends on
vi.mock('@/lib/queue/agent-run', () => ({
  AGENT_RUN_QUEUE_NAME: 'agent-run',
  enqueueAgentRun: vi.fn(async (data: { agentId: string }, opts?: { jobId?: string }) => ({
    id: opts?.jobId ?? 'generated-id',
    data,
  })),
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
});
