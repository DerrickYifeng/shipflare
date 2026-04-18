import { describe, it, expect, vi, beforeEach } from 'vitest';

const runSkillMock = vi.fn(async () => ({
  results: [{ tweets: ['ok'], confidence: 0.7, whyItWorks: 'fine' }],
  errors: [],
  usage: { costUsd: 0 },
}));

vi.mock('@/core/skill-runner', () => ({ runSkill: runSkillMock }));
vi.mock('@/core/skill-loader', () => ({ loadSkill: () => ({ name: 'slot-body' }) }));
vi.mock('@/memory/store', () => ({ MemoryStore: class {} }));
vi.mock('@/memory/prompt-builder', () => ({ buildMemoryPrompt: async () => '' }));
vi.mock('@/lib/queue', () => ({ enqueueReview: vi.fn() }));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));

vi.mock('@/lib/voice/inject', async () => {
  const actual = await vi.importActual<typeof import('@/lib/voice/inject')>('@/lib/voice/inject');
  return {
    ...actual,
    loadVoiceBlockForUser: async () => '<voice_profile>test-block</voice_profile>',
  };
});

const selectQueue: unknown[][] = [];
vi.mock('@/lib/db', () => ({
  db: {
    select: () => {
      const chain: Record<string, Function> = {};
      const terminal = () => selectQueue.shift() ?? [];
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
  runSkillMock.mockClear();
  selectQueue.length = 0;
});

describe('voice block injection contract', () => {
  it('slot-body processor passes voiceBlock into skill input', async () => {
    // Fixtures: calendar item → product → post history → theme → priorAngles
    selectQueue.push([{
      id: 'cal-1', isWhiteSpace: false, state: 'queued',
      topic: 't', contentType: 'metric', angle: 'story', themeId: 'theme-1', draftId: null,
    }]);
    selectQueue.push([{
      id: 'p', name: 'N', description: 'd', valueProp: 'v', keywords: [], lifecyclePhase: 'launched',
    }]);
    selectQueue.push([]); // post history empty
    selectQueue.push([{
      id: 'theme-1', thesis: 'claim', thesisSource: 'milestone', pillar: null, fallbackMode: null,
    }]);
    selectQueue.push([]); // priorAngles empty

    const { processCalendarSlotDraft } = await import('../calendar-slot-draft');
    await processCalendarSlotDraft({
      id: 'j',
      data: { schemaVersion: 1, userId: 'u', productId: 'p', calendarItemId: 'cal-1', channel: 'x' },
    } as never);
    const input = runSkillMock.mock.calls[0][0].input;
    expect(input.voiceBlock).toContain('test-block');
  });
});
