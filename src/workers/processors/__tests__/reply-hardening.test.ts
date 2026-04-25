import { describe, it, expect, vi, beforeEach } from 'vitest';

const runAgentMock = vi.fn();

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/platform-deps', () => ({ createPlatformDeps: async () => ({}) }));
vi.mock('@/lib/voice/inject', () => ({ loadVoiceBlockForUser: async () => null }));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));
vi.mock('@/memory/store', () => ({ MemoryStore: class {} }));
vi.mock('@/memory/prompt-builder', () => ({ buildMemoryPrompt: async () => '' }));
vi.mock('@/bridge/agent-runner', () => ({
  runAgent: runAgentMock,
  createToolContext: () => ({}),
}));
vi.mock('@/bridge/load-agent', () => ({
  loadAgentFromFile: (filePath: string) => ({
    name: filePath.includes('product-opportunity-judge') ? 'product-opportunity-judge' : 'x-reply-writer',
    systemPrompt: '',
    model: 'claude-haiku-4-5',
    tools: [],
    maxTurns: 5,
  }),
}));
vi.mock('@/tools/registry', () => ({
  registry: { toMap: () => new Map() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Reset module registry so each test gets a fresh import of reply-hardening
  vi.resetModules();
});

describe('reply pipeline hardening', () => {
  it('rejects drafts that fail ai-slop validation and emits skip', async () => {
    runAgentMock
      // product-opportunity-judge pass — mute
      .mockResolvedValueOnce({
        result: { allowMention: false, signal: 'no_fit', confidence: 0.9, reason: 'no fit' },
        usage: { costUsd: 0 },
      })
      // x-reply-writer pass — returns slop
      .mockResolvedValueOnce({
        result: {
          replyText: 'Great post! this really resonates.',
          confidence: 0.8,
          strategy: 'supportive_peer',
        },
        usage: { costUsd: 0 },
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
    runAgentMock
      .mockResolvedValueOnce({
        result: { allowMention: true, signal: 'tool_question', confidence: 0.8, reason: 'ask' },
        usage: { costUsd: 0 },
      })
      .mockResolvedValueOnce({
        result: {
          replyText: 'took us 14 months to hit that. channel was cold email.',
          confidence: 0.8,
          strategy: 'data_add',
        },
        usage: { costUsd: 0 },
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
    runAgentMock
      .mockResolvedValueOnce({
        result: { allowMention: false, signal: 'no_fit', confidence: 0.9, reason: 'no fit' },
        usage: { costUsd: 0 },
      })
      .mockResolvedValueOnce({
        result: { replyText: 'agree with this', confidence: 0.7, strategy: 'supportive_peer' },
        usage: { costUsd: 0 },
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
