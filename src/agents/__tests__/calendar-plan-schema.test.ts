import { describe, it, expect } from 'vitest';
import { calendarPlanOutputSchema } from '../schemas';

describe('calendarPlanOutputSchema', () => {
  it('accepts a plan with thesis + angles per entry', () => {
    const parsed = calendarPlanOutputSchema.parse({
      phase: 'growth',
      weeklyStrategy: 'prove the pricing thesis with 7 angles',
      thesis: 'pricing lower than competitors is a distribution moat',
      thesisSource: 'milestone',
      milestoneContext: 'shipped $19/mo tier',
      fallbackMode: null,
      whiteSpaceDayOffsets: [5, 6],
      entries: [
        { dayOffset: 0, hour: 14, contentType: 'metric', angle: 'claim', topic: 'the pricing thesis in one line' },
        { dayOffset: 1, hour: 17, contentType: 'educational', angle: 'howto', topic: 'how we arrived at $19' },
      ],
    });
    expect(parsed.thesis).toContain('pricing');
    expect(parsed.entries[0].angle).toBe('claim');
  });

  it('accepts a plan in fallback mode', () => {
    const parsed = calendarPlanOutputSchema.parse({
      phase: 'growth',
      weeklyStrategy: 'no ship this week — principle week',
      thesis: 'distribution > features for sub-1000 MRR products',
      thesisSource: 'fallback',
      fallbackMode: 'principle_week',
      whiteSpaceDayOffsets: [6],
      entries: [
        { dayOffset: 0, hour: 14, contentType: 'educational', angle: 'claim', topic: 'the claim' },
      ],
    });
    expect(parsed.fallbackMode).toBe('principle_week');
  });

  it('rejects a plan missing angle on an entry', () => {
    expect(() =>
      calendarPlanOutputSchema.parse({
        phase: 'growth',
        weeklyStrategy: 'x',
        thesis: 't-thesis-enough',
        thesisSource: 'milestone',
        whiteSpaceDayOffsets: [],
        entries: [{ dayOffset: 0, hour: 14, contentType: 'metric', topic: 't' }],
      }),
    ).toThrow();
  });

  it('rejects invalid thesisSource', () => {
    expect(() =>
      calendarPlanOutputSchema.parse({
        phase: 'growth',
        weeklyStrategy: 'x',
        thesis: 't-thesis-enough',
        thesisSource: 'unknown_source',
        whiteSpaceDayOffsets: [],
        entries: [],
      }),
    ).toThrow();
  });
});
