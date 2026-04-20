import { describe, it, expect } from 'vitest';
import { retrospectiveOutputSchema } from '@/agents/schemas';

const longForm = 'a'.repeat(400) + ' launch retrospective.';

describe('retrospectiveOutputSchema', () => {
  it('accepts a retro with all four sections and optional social digest', () => {
    const valid = {
      longForm,
      socialDigest: 'Short digest for X thread.',
      sections: {
        whatShipped: 'Shipped X and Y with specific numbers.',
        whatWorked: 'The confessional post drove 62% of week impressions.',
        whatDidNot: 'Email went out 4 hours late due to DKIM.',
        whatsNext: 'Next week: focus on activation gap.',
      },
    };
    expect(() => retrospectiveOutputSchema.parse(valid)).not.toThrow();
  });

  it('accepts a retro with socialDigest: null', () => {
    const valid = {
      longForm,
      socialDigest: null,
      sections: {
        whatShipped: 'x',
        whatWorked: 'x',
        whatDidNot: 'x',
        whatsNext: 'x',
      },
    };
    expect(() => retrospectiveOutputSchema.parse(valid)).not.toThrow();
  });

  it('rejects a longForm under 400 chars', () => {
    const invalid = {
      longForm: 'too short',
      socialDigest: null,
      sections: {
        whatShipped: 'x',
        whatWorked: 'x',
        whatDidNot: 'x',
        whatsNext: 'x',
      },
    };
    expect(() => retrospectiveOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects a social digest over 1000 chars', () => {
    const invalid = {
      longForm,
      socialDigest: 'a'.repeat(1100),
      sections: {
        whatShipped: 'x',
        whatWorked: 'x',
        whatDidNot: 'x',
        whatsNext: 'x',
      },
    };
    expect(() => retrospectiveOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects when a section is missing', () => {
    const invalid = {
      longForm,
      socialDigest: null,
      sections: {
        whatShipped: 'x',
        whatWorked: 'x',
        whatDidNot: 'x',
      },
    };
    expect(() => retrospectiveOutputSchema.parse(invalid)).toThrow();
  });
});
