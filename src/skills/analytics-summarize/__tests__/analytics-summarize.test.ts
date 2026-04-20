import { describe, it, expect } from 'vitest';
import { analyticsSummarizeOutputSchema } from '@/agents/schemas';

describe('analyticsSummarizeOutputSchema', () => {
  it('accepts a valid weekly summary', () => {
    const valid = {
      periodStart: '2026-04-13T00:00:00Z',
      periodEnd: '2026-04-19T23:59:59Z',
      headline:
        'Engagement rate fell 28% to 3.1% — the confessional post lost, the data post won.',
      summaryMd:
        'This week engagement dropped but the data-angle post was the top performer by 2x.\n\nKey movers...',
      highlights: [
        'Data-angle post hit 12,400 impressions — 3x the weekly avg.',
        'Followers grew +42, first delta > 30 since launch week.',
      ],
      lowlights: [
        'Engagement rate fell 28% to 3.1% overall.',
        'Replies sent dropped 60% Tue-Thu; monitor queue was empty.',
      ],
      metrics: {
        postsPublished: 7,
        repliesSent: 12,
        impressions: 11400,
        engagementRate: 0.031,
        topPostId: 'post_12',
      },
      recommendedNextMoves: [
        'Draft 2 contrarian-angle posts for Tuesday.',
        'Shift posting window to 14:00-17:00 UTC.',
      ],
    };
    expect(() =>
      analyticsSummarizeOutputSchema.parse(valid),
    ).not.toThrow();
  });

  it('rejects a headline longer than 240 chars', () => {
    const invalid = {
      periodStart: 's',
      periodEnd: 'e',
      headline: 'a'.repeat(260),
      summaryMd: 'x',
      highlights: ['h'],
      lowlights: ['l'],
      metrics: {
        postsPublished: 0,
        repliesSent: 0,
        impressions: 0,
        engagementRate: 0,
        topPostId: null,
      },
      recommendedNextMoves: ['do this'],
    };
    expect(() =>
      analyticsSummarizeOutputSchema.parse(invalid),
    ).toThrow();
  });

  it('rejects engagementRate > 1', () => {
    const invalid = {
      periodStart: 's',
      periodEnd: 'e',
      headline: 'h',
      summaryMd: 'x',
      highlights: ['h'],
      lowlights: ['l'],
      metrics: {
        postsPublished: 0,
        repliesSent: 0,
        impressions: 0,
        engagementRate: 1.2,
        topPostId: null,
      },
      recommendedNextMoves: ['do this'],
    };
    expect(() =>
      analyticsSummarizeOutputSchema.parse(invalid),
    ).toThrow();
  });

  it('rejects more than 5 recommendedNextMoves', () => {
    const invalid = {
      periodStart: 's',
      periodEnd: 'e',
      headline: 'h',
      summaryMd: 'x',
      highlights: ['h'],
      lowlights: ['l'],
      metrics: {
        postsPublished: 0,
        repliesSent: 0,
        impressions: 0,
        engagementRate: 0.5,
        topPostId: null,
      },
      recommendedNextMoves: ['a', 'b', 'c', 'd', 'e', 'f'],
    };
    expect(() =>
      analyticsSummarizeOutputSchema.parse(invalid),
    ).toThrow();
  });
});
