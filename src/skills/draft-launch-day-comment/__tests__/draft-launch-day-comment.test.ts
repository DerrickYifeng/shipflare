import { describe, it, expect } from 'vitest';
import { draftLaunchDayCommentOutputSchema } from '@/agents/schemas';

describe('draftLaunchDayCommentOutputSchema', () => {
  it('accepts a valid origin_story comment', () => {
    const valid = {
      comment:
        'Three months ago I opened a spreadsheet to plan my launch. ' +
        'By the time I was done I had 1200 rows of content ideas. ' +
        'ShipFlare came out of that exact morning. ' +
        'What is the one marketing task you would happily pay to stop doing?',
      openingHookKind: 'origin_story',
    };
    expect(() =>
      draftLaunchDayCommentOutputSchema.parse(valid),
    ).not.toThrow();
  });

  it('rejects a comment below 80 chars', () => {
    const invalid = {
      comment: 'too short',
      openingHookKind: 'problem_statement',
    };
    expect(() =>
      draftLaunchDayCommentOutputSchema.parse(invalid),
    ).toThrow();
  });

  it('rejects a comment above 1200 chars', () => {
    const invalid = {
      comment: 'a'.repeat(1300),
      openingHookKind: 'problem_statement',
    };
    expect(() =>
      draftLaunchDayCommentOutputSchema.parse(invalid),
    ).toThrow();
  });

  it('rejects an unknown opening hook kind', () => {
    const invalid = {
      comment: 'x'.repeat(120),
      openingHookKind: 'cliffhanger',
    };
    expect(() =>
      draftLaunchDayCommentOutputSchema.parse(invalid),
    ).toThrow();
  });
});
