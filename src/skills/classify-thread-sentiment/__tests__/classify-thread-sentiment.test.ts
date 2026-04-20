import { describe, it, expect } from 'vitest';
import { threadSentimentOutputSchema } from '@/agents/schemas';

describe('threadSentimentOutputSchema', () => {
  it('accepts each of the four labels', () => {
    for (const sentiment of ['pos', 'neg', 'neutral', 'mixed'] as const) {
      const valid = {
        sentiment,
        confidence: 0.7,
        rationale: 'example rationale',
      };
      expect(() =>
        threadSentimentOutputSchema.parse(valid),
      ).not.toThrow();
    }
  });

  it('rejects an unknown label', () => {
    const invalid = {
      sentiment: 'sad',
      confidence: 0.5,
      rationale: 'r',
    };
    expect(() => threadSentimentOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects a rationale over 240 chars', () => {
    const invalid = {
      sentiment: 'pos',
      confidence: 0.5,
      rationale: 'a'.repeat(260),
    };
    expect(() => threadSentimentOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects a confidence > 1', () => {
    const invalid = {
      sentiment: 'neutral',
      confidence: 1.3,
      rationale: 'r',
    };
    expect(() => threadSentimentOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects a negative confidence', () => {
    const invalid = {
      sentiment: 'neutral',
      confidence: -0.1,
      rationale: 'r',
    };
    expect(() => threadSentimentOutputSchema.parse(invalid)).toThrow();
  });
});
