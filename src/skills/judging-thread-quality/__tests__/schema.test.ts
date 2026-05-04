import { describe, it, expect } from 'vitest';
import { judgingThreadQualityOutputSchema } from '../schema';

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
