import { describe, it, expect, vi, beforeEach } from 'vitest';

const runSkillMock = vi.fn();

vi.mock('@/core/skill-runner', () => ({ runSkill: runSkillMock }));
vi.mock('@/core/skill-loader', () => ({ loadSkill: () => ({ name: 'slot-body' }) }));
vi.mock('@/memory/store', () => ({ MemoryStore: class {} }));
vi.mock('@/memory/prompt-builder', () => ({ buildMemoryPrompt: async () => '' }));
vi.mock('@/lib/queue', () => ({ enqueueReview: vi.fn() }));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));

// Sequential select mock: each call to db.select().from(...).where(...).limit(N)
// or .orderBy(...).limit(N) or .innerJoin(...).leftJoin(...).where(...) pulls
// the next queued result. Fixtures are per-test.
const selectQueue: unknown[][] = [];
function pushSelect(rows: unknown[]) { selectQueue.push(rows); }
function popSelect(): unknown[] { return selectQueue.shift() ?? []; }

vi.mock('@/lib/db', () => ({
  db: {
    select: () => {
      const chain: Record<string, Function> = {};
      const terminal = () => popSelect();
      chain.from = () => ({
        where: () => ({ limit: terminal, orderBy: () => ({ limit: terminal }) }),
        innerJoin: () => ({
          where: () => ({ orderBy: () => ({ limit: terminal }) }),
          leftJoin: () => ({ where: () => terminal() }),
        }),
        leftJoin: () => ({ where: () => terminal() }),
      });
      return chain;
    },
    insert: () => ({
      values: () => ({
        returning: () => [{ id: 'x-1' }],
        onConflictDoNothing: () => ({ returning: () => [{ id: 'thread-1' }] }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => ({}) }) }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
});

describe('processCalendarSlotDraft coherence', () => {
  it('skips white-space slots without calling slot-body', async () => {
    pushSelect([{ id: 'cal-1', isWhiteSpace: true, state: 'ready' }]);
    const { processCalendarSlotDraft } = await import('../calendar-slot-draft');
    await processCalendarSlotDraft({
      id: 'j',
      data: { schemaVersion: 1, userId: 'u', productId: 'p', calendarItemId: 'cal-1', channel: 'x' },
    } as never);
    expect(runSkillMock).not.toHaveBeenCalled();
  });

  it('passes thesis + angle + priorAnglesThisWeek into runSkill input', async () => {
    // Calendar item
    pushSelect([{
      id: 'cal-2', isWhiteSpace: false, state: 'queued',
      topic: 't', contentType: 'metric', angle: 'story',
      themeId: 'theme-1', draftId: null,
    }]);
    // Product
    pushSelect([{
      id: 'p', name: 'N', description: 'd', valueProp: 'v',
      keywords: [], lifecyclePhase: 'launched',
    }]);
    // Post history
    pushSelect([{ text: 'old post' }]);
    // Theme row
    pushSelect([{
      id: 'theme-1', thesis: 'pricing is distribution',
      thesisSource: 'milestone', pillar: 'pricing', fallbackMode: null,
    }]);
    // priorAngles query result (leftJoin drafts, filter to ready rows with angle+topic+body)
    pushSelect([
      { angle: 'claim', topic: 'claim-topic', replyBody: 'claim body' },
    ]);

    runSkillMock.mockResolvedValueOnce({
      results: [{ tweets: ['body'], confidence: 0.8, whyItWorks: 'ok' }],
      errors: [],
      usage: { costUsd: 0 },
    });

    const { processCalendarSlotDraft } = await import('../calendar-slot-draft');
    await processCalendarSlotDraft({
      id: 'j',
      data: { schemaVersion: 1, userId: 'u', productId: 'p', calendarItemId: 'cal-2', channel: 'x' },
    } as never);

    expect(runSkillMock).toHaveBeenCalledOnce();
    const input = runSkillMock.mock.calls[0][0].input;
    expect(input.thesis).toBe('pricing is distribution');
    expect(input.angle).toBe('story');
    expect(input.priorAnglesThisWeek).toEqual([
      { angle: 'claim', topic: 'claim-topic', body: 'claim body' },
    ]);
    expect(input.thesisSource).toBe('milestone');
    expect(input.pillar).toBe('pricing');
  });
});
