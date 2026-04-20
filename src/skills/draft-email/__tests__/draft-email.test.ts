import { describe, it, expect } from 'vitest';
import { draftEmailOutputSchema } from '@/agents/schemas';

describe('draftEmailOutputSchema', () => {
  it('accepts a minimal valid email (text only)', () => {
    const valid = {
      subject: 'week 1 retro: 347 signups, one regret',
      bodyText:
        'Week 1 after launch — 347 signups, 12% activation. Here is what surprised us.',
    };
    expect(() => draftEmailOutputSchema.parse(valid)).not.toThrow();
  });

  it('accepts an email with optional html + preview text', () => {
    const valid = {
      subject: 'welcome to ShipFlare',
      bodyText: 'You are on the waitlist. Number 142.',
      bodyHtml: '<p>You are on the waitlist. Number 142.</p>',
      previewText: 'What happens next, in under a minute.',
    };
    expect(() => draftEmailOutputSchema.parse(valid)).not.toThrow();
  });

  it('rejects an empty subject', () => {
    const invalid = { subject: '', bodyText: 'body' };
    expect(() => draftEmailOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects a subject that exceeds 120 chars', () => {
    const invalid = {
      subject: 'a'.repeat(121),
      bodyText: 'body',
    };
    expect(() => draftEmailOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects missing bodyText', () => {
    const invalid = { subject: 'hi' } as unknown;
    expect(() => draftEmailOutputSchema.parse(invalid)).toThrow();
  });
});
