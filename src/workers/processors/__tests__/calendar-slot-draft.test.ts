import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

type CalendarItemFixture = {
  id: string;
  state: 'queued' | 'drafting' | 'ready' | 'failed';
  draftId?: string;
  contentType: string;
  topic: string;
};

/**
 * Mutable holder for the `select().from(xContentCalendar).where().limit()` row
 * so tests can swap the "state" without leaning on `vi.doMock` + module resets,
 * which proved flaky with vitest's module cache. All other tables return empty.
 */
const dbState: { calendarItem: CalendarItemFixture } = {
  calendarItem: { id: 'ci-1', state: 'queued', contentType: 'metric', topic: 't' },
};

const fromBuilder = {
  where: () => ({
    limit: (n: number) => {
      void n;
      return [dbState.calendarItem];
    },
  }),
  innerJoin: () => ({
    where: () => ({
      orderBy: () => ({
        limit: () => [],
      }),
    }),
  }),
};

const productRow = {
  id: 'p',
  name: 'ShipFlare',
  description: 'd',
  valueProp: 'v',
  keywords: [],
  lifecyclePhase: 'pre_launch',
};

// Product lookup hits .from(products).where().limit(1) — return product row for
// that specific shape. Calendar item + followers all route through the same
// `from` builder, so we keep one factory and rely on the processor's linear
// flow to hit calendar item first (short-circuits before product on 'ready').
const productFromBuilder = {
  where: () => ({ limit: () => [productRow] }),
};

let currentFromBuilder: typeof fromBuilder | typeof productFromBuilder = fromBuilder;
let fromCallIdx = 0;

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => {
        fromCallIdx += 1;
        // Call order in processor: calendarItem (fromBuilder), then product
        // (productFromBuilder), then channelPosts join (fromBuilder).
        currentFromBuilder =
          fromCallIdx === 2 ? productFromBuilder : fromBuilder;
        return currentFromBuilder;
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    insert: () => ({
      values: () => ({
        returning: () => [{ id: 'draft-1' }],
        onConflictDoNothing: () => ({
          returning: () => [{ id: 'thread-1' }],
        }),
      }),
    }),
  },
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
  fromCallIdx = 0;
});

describe('processCalendarSlotDraft', () => {
  it('short-circuits when state=ready', async () => {
    dbState.calendarItem = {
      id: 'ci-1',
      state: 'ready',
      draftId: 'd-1',
      contentType: 'metric',
      topic: 't',
    };
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
    dbState.calendarItem = {
      id: 'ci-1',
      state: 'queued',
      contentType: 'metric',
      topic: 't',
    };
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
