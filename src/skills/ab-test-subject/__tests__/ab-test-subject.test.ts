import { describe, it, expect } from 'vitest';
import { abTestSubjectOutputSchema } from '@/agents/schemas';

describe('abTestSubjectOutputSchema', () => {
  it('accepts two complete variants', () => {
    const valid = {
      variantA: {
        subject: "week 1 retro — 347 signups, 12% activation",
        rationale: 'concrete specificity, number-forward opener',
      },
      variantB: {
        subject: 'what I learned shipping week 1',
        rationale: 'broad framing, builder-facing',
      },
    };
    expect(() => abTestSubjectOutputSchema.parse(valid)).not.toThrow();
  });

  it('rejects when a variant is missing', () => {
    const invalid = {
      variantA: { subject: 'hi', rationale: 'short' },
    };
    expect(() => abTestSubjectOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects when a subject exceeds the 120 char ceiling', () => {
    const invalid = {
      variantA: { subject: 'a'.repeat(121), rationale: 'ok' },
      variantB: { subject: 'short one', rationale: 'ok' },
    };
    expect(() => abTestSubjectOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects an empty rationale', () => {
    const invalid = {
      variantA: { subject: 'hi', rationale: '' },
      variantB: { subject: 'bye', rationale: 'short' },
    };
    expect(() => abTestSubjectOutputSchema.parse(invalid)).toThrow();
  });
});
