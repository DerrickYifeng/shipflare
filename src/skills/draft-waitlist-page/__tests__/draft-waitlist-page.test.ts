import { describe, it, expect } from 'vitest';
import { draftWaitlistPageOutputSchema } from '@/agents/schemas';

describe('draftWaitlistPageOutputSchema', () => {
  it('accepts a minimal valid page', () => {
    const valid = {
      html: '<main><h1>Ship marketing without thinking about it</h1></main>',
      copy: {
        headline: 'Ship marketing without thinking about it',
        subheadline:
          'ShipFlare writes the posts and replies for your launch — in your voice, not a GPT voice.',
        cta: 'Join the waitlist',
        valueBullets: [
          'Weekly calendar in your voice',
          'Replies to the right threads, not spam',
        ],
      },
    };
    expect(() => draftWaitlistPageOutputSchema.parse(valid)).not.toThrow();
  });

  it('rejects a page with only one value bullet', () => {
    const invalid = {
      html: '<main />',
      copy: {
        headline: 'Headline',
        subheadline: 'Sub',
        cta: 'Go',
        valueBullets: ['only one'],
      },
    };
    expect(() => draftWaitlistPageOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects more than 5 value bullets', () => {
    const invalid = {
      html: '<main />',
      copy: {
        headline: 'Headline',
        subheadline: 'Sub',
        cta: 'Go',
        valueBullets: ['a', 'b', 'c', 'd', 'e', 'f'],
      },
    };
    expect(() => draftWaitlistPageOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects an empty html field', () => {
    const invalid = {
      html: '',
      copy: {
        headline: 'h',
        subheadline: 's',
        cta: 'c',
        valueBullets: ['a', 'b'],
      },
    };
    expect(() => draftWaitlistPageOutputSchema.parse(invalid)).toThrow();
  });
});
