import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolContext } from '@/core/types';

// Mock the logger so the warn() call on failure is silent in tests.
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Spy hook for RedditClient.appOnly() — each test rewrites the
// `getSubredditRules` impl on the returned stub.
const getSubredditRulesMock = vi.fn();

vi.mock('@/lib/reddit-client', () => ({
  RedditClient: {
    appOnly: () => ({
      getSubredditRules: getSubredditRulesMock,
    }),
  },
}));

import { getSubredditRulesTool } from '../GetSubredditRulesTool';

function makeCtx(): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    get: () => {
      throw new Error('GetSubredditRulesTool should not need any deps');
    },
  };
}

describe('get_subreddit_rules', () => {
  beforeEach(() => {
    getSubredditRulesMock.mockReset();
  });

  it('declares the canonical tool name', () => {
    expect(getSubredditRulesTool.name).toBe('get_subreddit_rules');
  });

  it('is read-only and concurrency-safe (rule fetches do not mutate state)', () => {
    expect(getSubredditRulesTool.isReadOnly).toBe(true);
    expect(getSubredditRulesTool.isConcurrencySafe).toBe(true);
  });

  it('rejects empty subreddit input via Zod', () => {
    expect(() =>
      getSubredditRulesTool.inputSchema.parse({ subreddit: '' }),
    ).toThrow();
  });

  it('rejects subreddit input over 100 chars', () => {
    expect(() =>
      getSubredditRulesTool.inputSchema.parse({ subreddit: 'x'.repeat(101) }),
    ).toThrow();
  });

  it('maps RedditClient { title, description, kind } -> { short_name, description }', async () => {
    getSubredditRulesMock.mockResolvedValueOnce([
      {
        title: 'No self-promotion',
        description: 'Posts must not promote a product or service.',
        kind: 'all',
      },
      {
        title: 'Be civil',
        description: 'Treat each other with respect.',
        kind: 'comment',
      },
    ]);

    const result = await getSubredditRulesTool.execute(
      { subreddit: 'SaaS' },
      makeCtx(),
    );

    expect(result).toEqual([
      {
        short_name: 'No self-promotion',
        description: 'Posts must not promote a product or service.',
      },
      {
        short_name: 'Be civil',
        description: 'Treat each other with respect.',
      },
    ]);
    expect(getSubredditRulesMock).toHaveBeenCalledWith('SaaS');
  });

  it('returns [] when the upstream RedditClient throws (graceful degradation)', async () => {
    getSubredditRulesMock.mockRejectedValueOnce(
      new Error('Reddit API GET /r/foo/about/rules: 404'),
    );

    const result = await getSubredditRulesTool.execute(
      { subreddit: 'doesnotexist' },
      makeCtx(),
    );

    expect(result).toEqual([]);
  });

  it('returns [] when the subreddit has no rules', async () => {
    getSubredditRulesMock.mockResolvedValueOnce([]);

    const result = await getSubredditRulesTool.execute(
      { subreddit: 'BrandNew' },
      makeCtx(),
    );

    expect(result).toEqual([]);
  });
});
