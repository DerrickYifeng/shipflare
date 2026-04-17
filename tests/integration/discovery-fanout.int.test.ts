import { describe, it, expect, afterAll } from 'vitest';
import { enqueueSearchSource, searchSourceQueue } from '@/lib/queue';

describe('search-source fan-out', () => {
  afterAll(() => searchSourceQueue.obliterate({ force: true }));

  it('produces one job per (scanRunId, platform, source) with deterministic jobIds', async () => {
    const scanRunId = `scan-${Date.now()}`;
    const sources = ['r/a', 'r/b', 'r/c'];
    const ids = await Promise.all(
      sources.map((source) =>
        enqueueSearchSource({
          schemaVersion: 1,
          traceId: 't',
          userId: 'u',
          productId: 'p',
          platform: 'reddit',
          source,
          scanRunId,
        }),
      ),
    );
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(id).toMatch(new RegExp(`^ssrc-${scanRunId}-reddit-`));
    }
  });
});
