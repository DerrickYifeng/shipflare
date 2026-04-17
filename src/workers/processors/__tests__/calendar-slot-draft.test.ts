import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const mockFirst = <T>(val: T | undefined) => {
  // Shared builder that answers both .where().limit() (calendar item + product
  // lookups) and .innerJoin().where().orderBy().limit() (channel post history).
  const fromBuilder = {
    where: () => ({
      limit: () => (val ? [val] : []),
    }),
    innerJoin: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => [],
        }),
      }),
    }),
  };
  return {
    select: () => ({ from: () => fromBuilder }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    insert: () => ({
      values: () => ({
        returning: () => [{ id: 'draft-1' }],
        onConflictDoNothing: () => ({
          returning: () => [{ id: 'thread-1' }],
        }),
      }),
    }),
  };
};

vi.mock('@/lib/db', () => ({
  db: mockFirst({
    id: 'ci-1',
    state: 'queued',
    contentType: 'metric',
    topic: 't',
  }),
}));
vi.mock('@/lib/queue', () => ({ enqueueReview: vi.fn() }));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/core/skill-runner', () => ({
  runSkill: vi.fn(async () => ({
    results: [{ tweets: ['Hello'], confidence: 0.8, whyItWorks: 'because' }],
    errors: [],
    usage: { costUsd: 0.01 },
  })),
}));
vi.mock('@/memory/store', () => ({ MemoryStore: class {} }));
vi.mock('@/memory/prompt-builder', () => ({ buildMemoryPrompt: async () => '' }));
vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('processCalendarSlotDraft', () => {
  it('short-circuits when state=ready', async () => {
    vi.doMock('@/lib/db', () => ({
      db: mockFirst({
        id: 'ci-1',
        state: 'ready',
        draftId: 'd-1',
        contentType: 'metric',
        topic: 't',
      }),
    }));
    const { processCalendarSlotDraft } = await import('../calendar-slot-draft');
    const { runSkill } = await import('@/core/skill-runner');
    await processCalendarSlotDraft({
      id: 'job-1',
      data: {
        schemaVersion: 1,
        traceId: 't',
        userId: 'u',
        productId: 'p',
        calendarItemId: 'ci-1',
        channel: 'x',
      },
    } as Job);
    expect(runSkill).not.toHaveBeenCalled();
  });

  it('runs skill and transitions ready on success', async () => {
    vi.doMock('@/lib/db', () => ({
      db: mockFirst({
        id: 'ci-1',
        state: 'queued',
        contentType: 'metric',
        topic: 't',
      }),
    }));
    const { processCalendarSlotDraft } = await import('../calendar-slot-draft');
    const { publishUserEvent } = await import('@/lib/redis');
    await processCalendarSlotDraft({
      id: 'job-2',
      data: {
        schemaVersion: 1,
        traceId: 't',
        userId: 'u',
        productId: 'p',
        calendarItemId: 'ci-1',
        channel: 'x',
      },
    } as Job);
    expect(publishUserEvent).toHaveBeenCalledWith(
      'u',
      'agents',
      expect.objectContaining({
        type: 'pipeline',
        pipeline: 'plan',
        state: 'ready',
      }),
    );
  });
});
