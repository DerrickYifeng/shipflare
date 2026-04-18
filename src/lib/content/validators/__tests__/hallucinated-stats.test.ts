import { describe, expect, it } from 'vitest';
import { validateHallucinatedStats } from '../hallucinated-stats';

describe('validateHallucinatedStats', () => {
  it('passes text with no numeric claims', () => {
    const r = validateHallucinatedStats(
      'we shipped a new feature today. it feels good.',
    );
    expect(r.ok).toBe(true);
    expect(r.flaggedClaims).toEqual([]);
  });

  it('flags an unsourced percentage', () => {
    const r = validateHallucinatedStats('conversion improved 40% last month.');
    expect(r.ok).toBe(false);
    expect(r.flaggedClaims.some((c) => c.includes('40%'))).toBe(true);
  });

  it('flags an unsourced x-multiplier', () => {
    const r = validateHallucinatedStats('we got 10x more signups this week.');
    expect(r.ok).toBe(false);
    expect(r.flaggedClaims.some((c) => /10x/i.test(c))).toBe(true);
  });

  it('flags "over N"', () => {
    const r = validateHallucinatedStats('over 500 people signed up yesterday.');
    expect(r.ok).toBe(false);
  });

  it('flags "up to N"', () => {
    const r = validateHallucinatedStats('up to 300 requests per second.');
    expect(r.ok).toBe(false);
  });

  it('allows a percentage followed by "according to"', () => {
    const r = validateHallucinatedStats(
      'conversion improved 40%, according to our Stripe dashboard.',
    );
    expect(r.ok).toBe(true);
  });

  it('allows "per <Source>" citation', () => {
    const r = validateHallucinatedStats('retention rose 12% per Mixpanel.');
    expect(r.ok).toBe(true);
  });

  it('allows "source:" citation', () => {
    const r = validateHallucinatedStats('we 3x engagement. source: PostHog.');
    expect(r.ok).toBe(true);
  });

  it('allows an inline URL as citation', () => {
    const r = validateHallucinatedStats(
      '40% reduction in churn — https://example.com/report',
    );
    expect(r.ok).toBe(true);
  });

  it('allows an @handle attribution', () => {
    const r = validateHallucinatedStats('10x ARR in 6 months @paulg');
    expect(r.ok).toBe(true);
  });

  it('flags multiple stats in one draft', () => {
    const r = validateHallucinatedStats(
      'we 3x traffic, 40% more signups, and over 1000 paying users.',
    );
    expect(r.ok).toBe(false);
    expect(r.flaggedClaims.length).toBeGreaterThanOrEqual(2);
  });

  it('does not flag a citation-local stat but flags an unrelated later one', () => {
    // 40% must land >120 chars past the "per Mixpanel" citation so it falls
    // outside the citation window.
    const filler =
      ' then a bunch of unrelated context that pushes the next claim well outside the citation lookbehind window so we are sure the validator is not just blanket-passing the post. ';
    const r = validateHallucinatedStats(
      `retention rose 12% per Mixpanel.${filler}later, we saw 40% more bugs.`,
    );
    expect(r.ok).toBe(false);
    expect(r.flaggedClaims.some((c) => c.includes('40%'))).toBe(true);
  });
});
