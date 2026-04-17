import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const sourceCalls: Array<Record<string, unknown>> = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => [
      { id: 'p-1', name: 'P', keywords: [], description: '' },
    ] }) }) }),
  },
}));
vi.mock('@/lib/queue', () => ({
  enqueueSearchSource: vi.fn(async (data) => { sourceCalls.push(data); return 'job-id'; }),
}));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/lib/platform-config', () => ({
  getPlatformConfig: () => ({ defaultSources: ['r/SaaS', 'r/indiehackers'] }),
}));
vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));

beforeEach(() => { sourceCalls.length = 0; vi.clearAllMocks(); });

describe('processDiscoveryScan', () => {
  it('fans out one search-source job per default source', async () => {
    const { processDiscoveryScan } = await import('../discovery-scan');
    await processDiscoveryScan({
      id: 'j', data: {
        schemaVersion: 1, traceId: 't', userId: 'u', productId: 'p-1',
        platform: 'reddit', scanRunId: 'scan-xyz', trigger: 'manual',
      },
    } as Job);
    expect(sourceCalls).toHaveLength(2);
    expect(sourceCalls[0]).toMatchObject({ platform: 'reddit', source: 'r/SaaS', scanRunId: 'scan-xyz' });
  });
});
