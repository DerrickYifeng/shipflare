import { describe, it, expect, afterAll } from 'vitest';
import {
  searchSourceQueue,
  enqueueSearchSource,
} from '../index';

describe('enqueue helpers (requires Redis)', () => {
  afterAll(async () => {
    await searchSourceQueue.obliterate({ force: true });
    await searchSourceQueue.close();
  });

  it('dedupes search-source on (scanRunId, platform, source)', async () => {
    const data = {
      schemaVersion: 1 as const,
      traceId: 't-test',
      userId: 'u-test',
      productId: 'p-test',
      platform: 'reddit',
      source: 'r/SaaS',
      scanRunId: 'scan-xyz',
    };
    const id1 = await enqueueSearchSource(data);
    const id2 = await enqueueSearchSource(data);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^ssrc-scan-xyz-reddit-/);
  });
});
