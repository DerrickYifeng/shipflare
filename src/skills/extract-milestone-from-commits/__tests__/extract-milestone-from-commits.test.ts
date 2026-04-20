import { describe, it, expect } from 'vitest';
import { extractMilestoneOutputSchema } from '@/agents/schemas';

describe('extractMilestoneOutputSchema', () => {
  it('accepts a milestone for a release-tagged window', () => {
    const valid = {
      milestone: {
        title: 'Shipped beta — Reddit + onboarding v2 live',
        summary:
          'Beta release. Reddit connect + redesigned onboarding are the user-visible shifts.',
        source: 'release',
        sourceRef: 'v0.9.0',
        confidence: 0.9,
      },
    };
    expect(() => extractMilestoneOutputSchema.parse(valid)).not.toThrow();
  });

  it('accepts null for a chore-only window', () => {
    const valid = { milestone: null };
    expect(() => extractMilestoneOutputSchema.parse(valid)).not.toThrow();
  });

  it('rejects a milestone with an unknown source', () => {
    const invalid = {
      milestone: {
        title: 't',
        summary: 's',
        source: 'tweet',
        sourceRef: null,
        confidence: 0.5,
      },
    };
    expect(() => extractMilestoneOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects a confidence outside [0, 1]', () => {
    const invalid = {
      milestone: {
        title: 't',
        summary: 's',
        source: 'commit',
        sourceRef: 'abc',
        confidence: 1.5,
      },
    };
    expect(() => extractMilestoneOutputSchema.parse(invalid)).toThrow();
  });
});
