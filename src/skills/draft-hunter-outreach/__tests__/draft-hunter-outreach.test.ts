import { describe, it, expect } from 'vitest';
import { draftHunterOutreachOutputSchema } from '@/agents/schemas';

describe('draftHunterOutreachOutputSchema', () => {
  it('accepts a valid DM with personalization hook', () => {
    const valid = {
      dm: [
        'Saw you hunted RepoSpy last Tuesday — your comment on the',
        'analytics angle stuck with me. We are shipping ShipFlare on May',
        '14; it is the piece RepoSpy does not do. Would you hunt it?',
        'Totally no worries if it is not your lane. — Yifeng',
      ].join(' '),
      personalizationHook: 'your comment on the analytics angle on RepoSpy',
      confidence: 0.85,
    };
    expect(() => draftHunterOutreachOutputSchema.parse(valid)).not.toThrow();
  });

  it('rejects a DM below the 40-char floor', () => {
    const invalid = {
      dm: 'too short',
      personalizationHook: 'x',
      confidence: 0.5,
    };
    expect(() => draftHunterOutreachOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects a DM above the 700-char ceiling', () => {
    const invalid = {
      dm: 'a'.repeat(800),
      personalizationHook: 'x',
      confidence: 0.5,
    };
    expect(() => draftHunterOutreachOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects a confidence > 1', () => {
    const invalid = {
      dm: 'x'.repeat(100),
      personalizationHook: 'hook',
      confidence: 1.2,
    };
    expect(() => draftHunterOutreachOutputSchema.parse(invalid)).toThrow();
  });
});
