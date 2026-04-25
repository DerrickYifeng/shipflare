import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Covers the Task #3 content-validator integration in reply-hardening:
 *  - too-long drafts trigger a regen pass and fit within 240 chars
 *  - platform-leaks trigger a regen pass with repair prompt
 *  - unsourced stats trigger a regen pass
 *  - when all regen attempts still fail, needsReview is set + rejectionReasons includes content_validator:* codes
 */

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
  vi.resetModules();
});

const GOOD_REPLY = 'took us 14 months to get here. one channel: cold email.';

describe('reply-hardening content validators', () => {
  it('regenerates when the first draft is over 240 chars, then accepts the short one', async () => {
    // 1: judge, 2: first drafter pass (too long), 3: regenerated drafter pass (fits)
    runAgentMock
      .mockResolvedValueOnce({
        result: { allowMention: false, signal: 'no_fit', confidence: 0.9, reason: 'no fit' },
        usage: { costUsd: 0 },
      })
      .mockResolvedValueOnce({
        result: {
          replyText: 'a'.repeat(260), // blows 240 cap
          confidence: 0.8,
          strategy: 'data_add',
        },
        usage: { costUsd: 0 },
      })
      .mockResolvedValueOnce({
        result: {
          replyText: GOOD_REPLY,
          confidence: 0.8,
          strategy: 'data_add',
        },
        usage: { costUsd: 0 },
      });

    const { draftReplyWithHardening } = await import('../reply-hardening');
    const out = await draftReplyWithHardening({
      tweetId: 't1', tweetText: 'hit $10k mrr', authorUsername: 'u',
      product: { name: 'P', description: '', valueProp: '', keywords: [] },
    } as never);

    expect(out.strategy).toBe('data_add');
    expect(out.replyText).toBe(GOOD_REPLY);
    expect(out.needsReview).toBeUndefined();
    expect(runAgentMock).toHaveBeenCalledTimes(3);
    // The regen call should include repairPrompt mentioning the length cap.
    // runAgent signature: (config, userMessage, context, schema). userMessage is JSON string.
    const secondDrafterCall = runAgentMock.mock.calls[2];
    const userMessage = JSON.parse(secondDrafterCall[1] as string);
    const tweet = userMessage.tweets[0];
    expect(tweet.repairPrompt).toContain('240');
  });

  it('regenerates on platform-leak and accepts the clean draft', async () => {
    runAgentMock
      .mockResolvedValueOnce({
        result: { allowMention: false, signal: 'no_fit', confidence: 0.9, reason: 'no fit' },
        usage: { costUsd: 0 },
      })
      .mockResolvedValueOnce({
        result: {
          replyText: 'saw this same question on reddit yesterday too.',
          confidence: 0.8,
          strategy: 'data_add',
        },
        usage: { costUsd: 0 },
      })
      .mockResolvedValueOnce({
        result: {
          replyText: GOOD_REPLY,
          confidence: 0.8,
          strategy: 'data_add',
        },
        usage: { costUsd: 0 },
      });

    const { draftReplyWithHardening } = await import('../reply-hardening');
    const out = await draftReplyWithHardening({
      tweetId: 't2', tweetText: 'any ideas for marketing?', authorUsername: 'u',
      product: { name: 'P', description: '', valueProp: '', keywords: [] },
    } as never);

    expect(out.strategy).toBe('data_add');
    expect(out.needsReview).toBeUndefined();
    const secondDrafterCall = runAgentMock.mock.calls[2];
    const userMessage = JSON.parse(secondDrafterCall[1] as string);
    expect(userMessage.tweets[0].repairPrompt).toContain('reddit');
  });

  it('sets needsReview after exhausting regen retries', async () => {
    // Judge + 3 drafter attempts all over-length (initial + 2 regens).
    runAgentMock.mockResolvedValueOnce({
      result: { allowMention: false, signal: 'no_fit', confidence: 0.9, reason: 'no fit' },
      usage: { costUsd: 0 },
    });

    for (let i = 0; i < 3; i++) {
      runAgentMock.mockResolvedValueOnce({
        result: { replyText: 'b'.repeat(260), confidence: 0.8, strategy: 'data_add' },
        usage: { costUsd: 0 },
      });
    }

    const { draftReplyWithHardening } = await import('../reply-hardening');
    const out = await draftReplyWithHardening({
      tweetId: 't3', tweetText: 'hit $10k mrr', authorUsername: 'u',
      product: { name: 'P', description: '', valueProp: '', keywords: [] },
    } as never);

    expect(out.strategy).toBe('skip');
    expect(out.needsReview).toBe(true);
    expect(out.rejectionReasons).toContain('content_validator:length');
    expect(out.contentValidatorFailures).toBeDefined();
    expect(out.contentValidatorFailures?.[0].validator).toBe('length');
    // 1 judge + 3 drafter attempts (initial + 2 regens)
    expect(runAgentMock).toHaveBeenCalledTimes(4);
  });

  it('still rejects AI-slop even when content validators pass', async () => {
    runAgentMock
      .mockResolvedValueOnce({
        result: { allowMention: false, signal: 'no_fit', confidence: 0.9, reason: 'no fit' },
        usage: { costUsd: 0 },
      })
      .mockResolvedValueOnce({
        result: {
          // Under 240 chars, no platform leak, no stats, but has a preamble.
          replyText: 'Great post! shipped my first SaaS in 2024.',
          confidence: 0.8,
          strategy: 'supportive_peer',
        },
        usage: { costUsd: 0 },
      });

    const { draftReplyWithHardening } = await import('../reply-hardening');
    const out = await draftReplyWithHardening({
      tweetId: 't4', tweetText: 'hit $10k mrr', authorUsername: 'u',
      product: { name: 'P', description: '', valueProp: '', keywords: [] },
    } as never);

    expect(out.strategy).toBe('skip');
    expect(out.rejectionReasons).toContain('preamble_opener');
    expect(out.needsReview).toBeUndefined();
  });
});
