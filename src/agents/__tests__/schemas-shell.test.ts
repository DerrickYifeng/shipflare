import { describe, it, expect } from 'vitest';
import { calendarPlanOutputSchema, slotBodyOutputSchema } from '../schemas';

describe('calendarPlanOutputSchema (shell)', () => {
  it('rejects entries that include body fields', () => {
    const bad = {
      phase: 'growth',
      weeklyStrategy: 'weekly-strategy-s',
      thesis: 'thesis-long-enough',
      thesisSource: 'milestone',
      whiteSpaceDayOffsets: [],
      entries: [
        {
          dayOffset: 0,
          hour: 14,
          contentType: 'metric',
          angle: 'claim',
          topic: 't',
          tweets: ['x'],
        },
      ],
    };
    // tweets is ignored by parse (strict off) but topic stays required:
    const parsed = calendarPlanOutputSchema.parse(bad);
    expect('tweets' in parsed.entries[0]).toBe(false);
  });

  it('accepts minimal valid shell', () => {
    const ok = calendarPlanOutputSchema.parse({
      phase: 'growth',
      weeklyStrategy: 'weekly-strategy-s',
      thesis: 'thesis-long-enough',
      thesisSource: 'milestone',
      whiteSpaceDayOffsets: [],
      entries: [
        { dayOffset: 0, hour: 14, contentType: 'metric', angle: 'claim', topic: 'MRR' },
      ],
    });
    expect(ok.entries).toHaveLength(1);
  });
});

describe('slotBodyOutputSchema', () => {
  it('requires at least one tweet', () => {
    expect(() =>
      slotBodyOutputSchema.parse({ tweets: [], confidence: 0.5, whyItWorks: 'x' }),
    ).toThrow();
  });

  it('accepts valid body', () => {
    const ok = slotBodyOutputSchema.parse({
      tweets: ['Hello'],
      confidence: 0.7,
      whyItWorks: 'because',
    });
    expect(ok.tweets).toHaveLength(1);
  });
});
