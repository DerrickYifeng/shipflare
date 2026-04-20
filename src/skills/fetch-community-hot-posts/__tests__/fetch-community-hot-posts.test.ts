import { describe, it, expect } from 'vitest';
import { communityHotPostsOutputSchema } from '@/agents/schemas';

describe('communityHotPostsOutputSchema', () => {
  it('accepts a valid hot-post summary', () => {
    const valid = {
      community: 'SaaS',
      topFormats: [
        'outcome-first, numeric headline',
        'confessional mistake-first opener',
        'teardown with headings',
      ],
      avgEngagement: { upvotes: 142, comments: 18 },
      insight:
        'Confessional mistake-first posts outperform tutorials 2:1 this week. Lead with a specific miss the reader recognizes.',
      samplePostIds: ['abc', 'def', 'ghi'],
    };
    expect(() => communityHotPostsOutputSchema.parse(valid)).not.toThrow();
  });

  it('rejects an empty topFormats array', () => {
    const invalid = {
      community: 'x',
      topFormats: [],
      avgEngagement: { upvotes: 0, comments: 0 },
      insight: 'x',
      samplePostIds: [],
    };
    expect(() => communityHotPostsOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects a negative upvote average', () => {
    const invalid = {
      community: 'x',
      topFormats: ['short'],
      avgEngagement: { upvotes: -1, comments: 0 },
      insight: 'x',
      samplePostIds: [],
    };
    expect(() => communityHotPostsOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects an insight over the 600-char ceiling', () => {
    const invalid = {
      community: 'x',
      topFormats: ['short'],
      avgEngagement: { upvotes: 10, comments: 2 },
      insight: 'a'.repeat(700),
      samplePostIds: [],
    };
    expect(() => communityHotPostsOutputSchema.parse(invalid)).toThrow();
  });
});
