import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

type CalendarItemFixture = {
  id: string;
  state: 'queued' | 'drafting' | 'ready' | 'failed';
  draftId?: string;
  contentType: string;
  topic: string;
  isWhiteSpace?: boolean;
  angle?: string;
  themeId?: string;
};

/**
 * Mutable holder for the `select().from(xContentCalendar).where().limit()` row
 * so tests can swap the "state" without leaning on `vi.doMock` + module resets,
 * which proved flaky with vitest's module cache. All other tables return empty.
 */
const dbState: { calendarItem: CalendarItemFixture } = {
  calendarItem: {
    id: 'ci-1', state: 'queued', contentType: 'metric', topic: 't',
    isWhiteSpace: false, angle: 'claim', themeId: 'theme-1',
  },
};

const themeRow = {
  id: 'theme-1',
  thesis: 'test thesis',
  thesisSource: 'fallback',
  pillar: null,
  fallbackMode: null,
};

const productRow = {
  id: 'p',
  name: 'ShipFlare',
  description: 'd',
  valueProp: 'v',
  keywords: [],
  lifecyclePhase: 'pre_launch',
};

// Call order in processor (non-whiteSpace, queued):
//  1: calendarItem  — from(xContentCalendar).where().limit()
//  2: product       — from(products).where().limit()
//  3: postHistory   — from(channelPosts).innerJoin().where().orderBy().limit()
//  4: theme         — from(weeklyThemes).where().limit()
//  5: priorAngles   — from(xContentCalendar).leftJoin().where()
let fromCallIdx = 0;

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => {
        fromCallIdx += 1;
        const idx = fromCallIdx;

        if (idx === 1) {
          // calendarItem
          return {
            where: () => ({
              limit: () => [dbState.calendarItem],
            }),
          };
        }
        if (idx === 2) {
          // product
          return {
            where: () => ({ limit: () => [productRow] }),
          };
        }
        if (idx === 3) {
          // postHistory (innerJoin)
          return {
            innerJoin: () => ({
              where: () => ({
                orderBy: () => ({ limit: () => [] }),
              }),
            }),
          };
        }
        if (idx === 4) {
          // theme
          return {
            where: () => ({ limit: () => [themeRow] }),
          };
        }
        // idx === 5: priorAngles (leftJoin)
        return {
          leftJoin: () => ({
            where: () => [],
          }),
        };
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
vi.mock('@/lib/voice/inject', () => ({ loadVoiceBlockForUser: async () => null }));
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
  dbState.calendarItem = {
    id: 'ci-1', state: 'queued', contentType: 'metric', topic: 't',
    isWhiteSpace: false, angle: 'claim', themeId: 'theme-1',
  };
});

describe('processCalendarSlotDraft', () => {
  it('short-circuits when state=ready', async () => {
    dbState.calendarItem = {
      id: 'ci-1',
      state: 'ready',
      draftId: 'd-1',
      contentType: 'metric',
      topic: 't',
      isWhiteSpace: false,
      angle: 'claim',
      themeId: 'theme-1',
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
      isWhiteSpace: false,
      angle: 'claim',
      themeId: 'theme-1',
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
