import { describe, it, expect } from 'vitest';
import {
  judgingThreadQualityInputSchema,
  judgingThreadQualityOutputSchema,
} from '../schema';

describe('judging-thread-quality schema — canMentionProduct fields', () => {
  it('parses canMentionProduct + mentionSignal in the output', () => {
    const parsed = judgingThreadQualityOutputSchema.parse({
      keep: true,
      score: 0.85,
      reason: 'asks for tool',
      signals: ['help_request'],
      canMentionProduct: true,
      mentionSignal: 'tool_question',
    });
    expect(parsed.canMentionProduct).toBe(true);
    expect(parsed.mentionSignal).toBe('tool_question');
  });

  it('defaults canMentionProduct to false when omitted (legacy responses)', () => {
    const parsed = judgingThreadQualityOutputSchema.parse({
      keep: true,
      score: 0.85,
      reason: 'asks for tool',
      signals: [],
    });
    expect(parsed.canMentionProduct).toBe(false);
    expect(parsed.mentionSignal).toBe('no_fit');
  });

  it('rejects invalid mentionSignal values (catches enum/reference drift)', () => {
    expect(() =>
      judgingThreadQualityOutputSchema.parse({
        keep: false,
        score: 0.5,
        reason: 'milestone celebration',
        signals: [],
        mentionSignal: 'milestone_celebration', // long form NOT in MENTION_SIGNALS
      }),
    ).toThrow();
  });
});

describe('judging-thread-quality schema — input authorBio / authorFollowers', () => {
  const baseProduct = {
    name: 'P',
    description: 'D',
  };
  const baseCandidate = {
    title: 't',
    body: 'b',
    author: 'a',
    platform: 'x' as const,
    postedAt: '2026-04-25T14:00:00Z',
  };

  it('accepts authorBio + authorFollowers when present', () => {
    const parsed = judgingThreadQualityInputSchema.parse({
      candidate: {
        ...baseCandidate,
        authorBio: 'indie hacker building thing',
        authorFollowers: 1234,
      },
      product: baseProduct,
    });
    expect(parsed.candidate.authorBio).toBe('indie hacker building thing');
    expect(parsed.candidate.authorFollowers).toBe(1234);
  });

  it('accepts null authorBio + authorFollowers (xAI couldn\'t resolve)', () => {
    const parsed = judgingThreadQualityInputSchema.parse({
      candidate: {
        ...baseCandidate,
        authorBio: null,
        authorFollowers: null,
      },
      product: baseProduct,
    });
    expect(parsed.candidate.authorBio).toBeNull();
    expect(parsed.candidate.authorFollowers).toBeNull();
  });

  it('accepts candidate without authorBio / authorFollowers (back-compat)', () => {
    const parsed = judgingThreadQualityInputSchema.parse({
      candidate: baseCandidate,
      product: baseProduct,
    });
    expect(parsed.candidate.authorBio).toBeUndefined();
    expect(parsed.candidate.authorFollowers).toBeUndefined();
  });

  it('rejects non-integer authorFollowers', () => {
    expect(() =>
      judgingThreadQualityInputSchema.parse({
        candidate: {
          ...baseCandidate,
          authorFollowers: 12.5,
        },
        product: baseProduct,
      }),
    ).toThrow();
  });
});
