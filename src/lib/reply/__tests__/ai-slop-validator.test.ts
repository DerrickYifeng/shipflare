import { describe, it, expect } from 'vitest';
import { validateAiSlop } from '../ai-slop-validator';

describe('validateAiSlop', () => {
  it('passes a clean reply', () => {
    const result = validateAiSlop('$10k is the hard one. the second 10k is faster.');
    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('rejects em-dash overuse (2+ em-dashes)', () => {
    const result = validateAiSlop('this is great \u2014 really great \u2014 couldn\u2019t agree more');
    expect(result.pass).toBe(false);
    expect(result.violations).toContain('em_dash_overuse');
  });

  it('rejects binary "not X, it\'s Y" construction', () => {
    const result = validateAiSlop("it's not just speed, it's precision.");
    expect(result.pass).toBe(false);
    expect(result.violations).toContain('binary_not_x_its_y');
  });

  it('rejects preamble openers (great post, interesting take, as someone who)', () => {
    for (const draft of [
      'Great post! this resonates.',
      'Interesting take on pricing.',
      'As someone who has shipped 3 products, agree.',
      'I noticed you mentioned churn.',
    ]) {
      const result = validateAiSlop(draft);
      expect(result.pass, `failed to reject: ${draft}`).toBe(false);
      expect(result.violations).toContain('preamble_opener');
    }
  });

  it('rejects banned AI vocabulary', () => {
    for (const word of ['delve', 'leverage', 'utilize', 'robust', 'crucial', 'demystify', 'landscape']) {
      const result = validateAiSlop(`you should ${word} the opportunity`);
      expect(result.pass, `failed on word: ${word}`).toBe(false);
      expect(result.violations).toContain('banned_vocabulary');
    }
  });

  it('rejects triple-grouping rhythm ("fast, efficient, reliable")', () => {
    const result = validateAiSlop('built it to be fast, efficient, and reliable.');
    expect(result.pass).toBe(false);
    expect(result.violations).toContain('triple_grouping');
  });

  it('rejects negation cadence ("no fluff. no theory. just results.")', () => {
    const result = validateAiSlop('no fluff. no theory. just results.');
    expect(result.pass).toBe(false);
    expect(result.violations).toContain('negation_cadence');
  });

  it('rejects engagement-bait filler ("this.", "100%.", "so true.")', () => {
    for (const draft of ['This.', '100%.', 'so true!', 'bookmarked \uD83D\uDCCC']) {
      const result = validateAiSlop(draft);
      expect(result.pass, `failed on: ${draft}`).toBe(false);
    }
  });

  it('reports all violations when multiple patterns present', () => {
    const result = validateAiSlop('Great question! let me delve \u2014 really delve \u2014 into this.');
    expect(result.pass).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('case-insensitive for preamble and vocab', () => {
    expect(validateAiSlop('LEVERAGE this').pass).toBe(false);
    expect(validateAiSlop('gReAt PoSt!').pass).toBe(false);
  });
});
