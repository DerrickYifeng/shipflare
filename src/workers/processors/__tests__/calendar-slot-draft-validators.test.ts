import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

/**
 * Covers the Task #3 content-validator integration in calendar-slot-draft:
 *  - passes `platform` into the slot-body skill input
 *  - regenerates when the first body fails length validation
 *  - persists a `needs_revision` draft with `reviewJson` when regen exhausts
 */

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

const draftInsertValues: Array<Record<string, unknown>> = [];
let fromCallIdx = 0;

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => {
        fromCallIdx += 1;
        const idx = fromCallIdx;
        if (idx === 1) {
          return { where: () => ({ limit: () => [dbState.calendarItem] }) };
        }
        if (idx === 2) {
          return { where: () => ({ limit: () => [productRow] }) };
        }
        if (idx === 3) {
          return {
            innerJoin: () => ({
              where: () => ({ orderBy: () => ({ limit: () => [] }) }),
            }),
          };
        }
        if (idx === 4) {
          return { where: () => ({ limit: () => [themeRow] }) };
        }
        return { leftJoin: () => ({ where: () => [] }) };
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    insert: (table: unknown) => {
      const tableName = String((table as { _?: { name?: string } })?._?.name ?? '');
      return {
        values: (vals: Record<string, unknown>) => {
          if (tableName.includes('draft') || 'replyBody' in vals) {
            draftInsertValues.push(vals);
          }
          return {
            returning: () => [{ id: 'draft-1' }],
            onConflictDoNothing: () => ({
              returning: () => [{ id: 'thread-1' }],
            }),
          };
        },
      };
    },
  },
}));
vi.mock('@/lib/voice/inject', () => ({ loadVoiceBlockForUser: async () => null }));
vi.mock('@/lib/queue', () => ({ enqueueReview: vi.fn() }));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/memory/store', () => ({ MemoryStore: class {} }));
vi.mock('@/memory/prompt-builder', () => ({ buildMemoryPrompt: async () => '' }));
vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));

const runSkillMock = vi.fn();
vi.mock('@/core/skill-runner', () => ({ runSkill: runSkillMock }));

beforeEach(() => {
  vi.clearAllMocks();
  fromCallIdx = 0;
  draftInsertValues.length = 0;
  dbState.calendarItem = {
    id: 'ci-1', state: 'queued', contentType: 'metric', topic: 't',
    isWhiteSpace: false, angle: 'claim', themeId: 'theme-1',
  };
});

const goodTweet = 'shipped the scheduler. all the weekly plans now run at 3am.';

describe('processCalendarSlotDraft content validators', () => {
  it('passes platform into the slot-body skill input', async () => {
    runSkillMock.mockResolvedValueOnce({
      results: [{ tweets: [goodTweet], confidence: 0.8, whyItWorks: 'because' }],
      errors: [],
      usage: { costUsd: 0.01 },
    });

    const { processCalendarSlotDraft } = await import('../calendar-slot-draft');
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

    const firstCall = runSkillMock.mock.calls[0][0];
    expect(firstCall.input.platform).toBe('x');
    expect(firstCall.input.isThread).toBe(false);
  });

  it('regenerates when the first body is over 280 chars and accepts the short one', async () => {
    runSkillMock
      .mockResolvedValueOnce({
        results: [{ tweets: ['x'.repeat(300)], confidence: 0.8, whyItWorks: 'long' }],
        errors: [],
        usage: { costUsd: 0.01 },
      })
      .mockResolvedValueOnce({
        results: [{ tweets: [goodTweet], confidence: 0.8, whyItWorks: 'short' }],
        errors: [],
        usage: { costUsd: 0.01 },
      });

    const { processCalendarSlotDraft } = await import('../calendar-slot-draft');
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

    expect(runSkillMock).toHaveBeenCalledTimes(2);
    const secondCall = runSkillMock.mock.calls[1][0];
    expect(secondCall.input.repairPrompt).toBeDefined();
    expect(secondCall.input.repairPrompt).toContain('280');

    const persisted = draftInsertValues.at(-1);
    expect(persisted).toBeDefined();
    expect(persisted?.status).toBeUndefined(); // default 'pending' — not needs_revision
  });

  it('marks draft needs_revision when regen retries exhaust', async () => {
    for (let i = 0; i < 3; i++) {
      runSkillMock.mockResolvedValueOnce({
        results: [{ tweets: ['y'.repeat(300)], confidence: 0.8, whyItWorks: 'still long' }],
        errors: [],
        usage: { costUsd: 0.01 },
      });
    }

    const { processCalendarSlotDraft } = await import('../calendar-slot-draft');
    await processCalendarSlotDraft({
      id: 'job-3',
      data: {
        schemaVersion: 1,
        traceId: 't',
        userId: 'u',
        productId: 'p',
        calendarItemId: 'ci-1',
        channel: 'x',
      },
    } as Job);

    expect(runSkillMock).toHaveBeenCalledTimes(3); // initial + 2 regens
    const persisted = draftInsertValues.at(-1);
    expect(persisted).toBeDefined();
    expect(persisted?.status).toBe('needs_revision');
    expect(persisted?.reviewVerdict).toBe('REVISE');
    const reviewJson = persisted?.reviewJson as { source: string; failures: unknown[] };
    expect(reviewJson.source).toBe('content-validator');
    expect(Array.isArray(reviewJson.failures)).toBe(true);
    expect(reviewJson.failures.length).toBeGreaterThan(0);
  });
});
