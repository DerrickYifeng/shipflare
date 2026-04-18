import { describe, it, expect, vi, beforeEach } from 'vitest';

const runSkillMock = vi.fn();

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/platform-deps', () => ({ createPlatformDeps: async () => ({}) }));
vi.mock('@/lib/voice/inject', () => ({ loadVoiceBlockForUser: async () => null }));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));
vi.mock('@/memory/store', () => ({ MemoryStore: class {} }));
vi.mock('@/memory/prompt-builder', () => ({ buildMemoryPrompt: async () => '' }));
vi.mock('@/core/skill-runner', () => ({ runSkill: runSkillMock }));
// Mock loadSkill so the helper can pre-load both skills without hitting the FS
vi.mock('@/core/skill-loader', () => ({
  loadSkill: (dir: string) => ({ name: dir.includes('product-opportunity-judge') ? 'product-opportunity-judge' : 'reply-scan' }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Reset module registry so each test gets a fresh import of reply-hardening
  vi.resetModules();
});

describe('reply pipeline hardening', () => {
  it('rejects drafts that fail ai-slop validation and emits skip', async () => {
    runSkillMock
      // product-opportunity-judge pass — mute
      .mockResolvedValueOnce({
        results: [{ allowMention: false, signal: 'no_fit', confidence: 0.9, reason: 'no fit' }],
        errors: [], usage: { costUsd: 0 },
      })
      // reply-drafter pass — returns slop
      .mockResolvedValueOnce({
        results: [{
          replyText: 'Great post! this really resonates.',
          confidence: 0.8,
          strategy: 'supportive_peer',
        }],
        errors: [], usage: { costUsd: 0 },
      });

    const { draftReplyWithHardening } = await import('../reply-hardening');
    const out = await draftReplyWithHardening({
      tweetId: 't1', tweetText: 'shipping my first SaaS',
      authorUsername: 'u', product: { name: 'P', description: '', valueProp: '', keywords: [] },
    } as never);

    expect(out.strategy).toBe('skip');
    expect(out.rejectionReasons).toContain('preamble_opener');
  });

  it('accepts drafts that pass both validators', async () => {
    runSkillMock
      .mockResolvedValueOnce({
        results: [{ allowMention: true, signal: 'tool_question', confidence: 0.8, reason: 'ask' }],
        errors: [], usage: { costUsd: 0 },
      })
      .mockResolvedValueOnce({
        results: [{
          replyText: 'took us 14 months to hit that. channel was cold email.',
          confidence: 0.8,
          strategy: 'data_add',
        }],
        errors: [], usage: { costUsd: 0 },
      });

    const { draftReplyWithHardening } = await import('../reply-hardening');
    const out = await draftReplyWithHardening({
      tweetId: 't2', tweetText: 'hit $10k mrr',
      authorUsername: 'u', product: { name: 'P', description: '', valueProp: '', keywords: [] },
    } as never);

    expect(out.strategy).toBe('data_add');
    expect(out.replyText).toContain('14 months');
    expect(out.canMentionProduct).toBe(true);
  });

  it('rejects drafts with no anchor token', async () => {
    runSkillMock
      .mockResolvedValueOnce({
        results: [{ allowMention: false, signal: 'no_fit', confidence: 0.9, reason: 'no fit' }],
        errors: [], usage: { costUsd: 0 },
      })
      .mockResolvedValueOnce({
        results: [{ replyText: 'agree with this', confidence: 0.7, strategy: 'supportive_peer' }],
        errors: [], usage: { costUsd: 0 },
      });

    const { draftReplyWithHardening } = await import('../reply-hardening');
    const out = await draftReplyWithHardening({
      tweetId: 't3', tweetText: '...', authorUsername: 'u',
      product: { name: 'P', description: '', valueProp: '', keywords: [] },
    } as never);

    expect(out.strategy).toBe('skip');
    expect(out.rejectionReasons).toContain('no_anchor_token');
  });
});
