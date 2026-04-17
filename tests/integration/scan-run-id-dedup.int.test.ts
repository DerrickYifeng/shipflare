import { describe, it, expect, afterAll } from 'vitest';
import { enqueueDiscoveryScan, discoveryScanQueue } from '@/lib/queue';

describe('discovery-scan dedup', () => {
  afterAll(() => discoveryScanQueue.obliterate({ force: true }));

  it('same scanRunId + platform collapses to one job', async () => {
    const payload = {
      schemaVersion: 1 as const,
      traceId: 't',
      userId: 'u',
      productId: 'p',
      platform: 'reddit',
      scanRunId: 'scan-dup',
      trigger: 'manual' as const,
    };
    const id1 = await enqueueDiscoveryScan(payload);
    const id2 = await enqueueDiscoveryScan(payload);
    expect(id1).toBe(id2);
    expect(id1).toBe('scan-scan-dup-reddit');
  });

  it('same scanRunId but different platforms mint distinct jobs', async () => {
    const base = {
      schemaVersion: 1 as const,
      traceId: 't',
      userId: 'u2',
      productId: 'p',
      scanRunId: 'scan-multi',
      trigger: 'manual' as const,
    };
    const reddit = await enqueueDiscoveryScan({ ...base, platform: 'reddit' });
    const x = await enqueueDiscoveryScan({ ...base, platform: 'x' });
    expect(reddit).toBe('scan-scan-multi-reddit');
    expect(x).toBe('scan-scan-multi-x');
    expect(reddit).not.toBe(x);
  });
});
