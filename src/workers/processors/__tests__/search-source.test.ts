import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const threadsReturning = vi.fn(() => [{ id: 'th-1', externalId: 'ext-1' }]);

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => [{ id: 'p-1', name: 'P' }] }) }) }),
    insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: threadsReturning }) }) }),
  },
}));
vi.mock('@/lib/platform-deps', () => ({ createPlatformDeps: async () => ({}) }));
vi.mock('@/lib/queue', () => ({}));
vi.mock('@/lib/redis', () => ({
  publishUserEvent: vi.fn(),
  getKeyValueClient: () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
  }),
}));
vi.mock('@/core/skill-runner', () => ({
  runSkill: vi.fn(async () => ({
    results: [{
      threads: [{ id: 'ext-1', community: 'r/SaaS', title: 't', url: 'http://x', relevanceScore: 85 }],
    }],
    errors: [],
    usage: { costUsd: 0.005 },
  })),
}));
vi.mock('@/memory/store', () => ({ MemoryStore: class {} }));
vi.mock('@/memory/prompt-builder', () => ({ buildMemoryPrompt: async () => '' }));
vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe('processSearchSource', () => {
  it('publishes source_searched after inserting above-gate threads', async () => {
    const { processSearchSource } = await import('../search-source');
    const { publishUserEvent } = await import('@/lib/redis');
    await processSearchSource({
      id: 'job-1',
      data: {
        schemaVersion: 1, traceId: 't', userId: 'u', productId: 'p',
        platform: 'reddit', source: 'r/SaaS', scanRunId: 'scan-1',
      },
    } as Job);
    expect(publishUserEvent).toHaveBeenCalledWith('u', 'agents',
      expect.objectContaining({ type: 'pipeline', pipeline: 'discovery', state: 'searched' }));
  });

  it('publishes source_searched with found:0 when skill returns nothing', async () => {
    const { runSkill } = await import('@/core/skill-runner');
    (runSkill as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      results: [{ threads: [] }], errors: [], usage: { costUsd: 0.001 },
    });
    threadsReturning.mockReturnValueOnce([]);
    const { processSearchSource } = await import('../search-source');
    const { publishUserEvent } = await import('@/lib/redis');
    await processSearchSource({
      id: 'job-2',
      data: {
        schemaVersion: 1, traceId: 't', userId: 'u', productId: 'p',
        platform: 'reddit', source: 'r/empty', scanRunId: 'scan-1',
      },
    } as Job);
    expect(publishUserEvent).toHaveBeenCalled();
  });
});
