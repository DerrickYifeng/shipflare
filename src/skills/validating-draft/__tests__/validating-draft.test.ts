import { describe, it, expect } from 'vitest';
import { validatingDraftOutputSchema } from '../schema';

const sampleChecks = [
  { name: 'relevance', result: 'PASS' as const, detail: 'addresses the OP' },
  { name: 'value_first', result: 'PASS' as const, detail: 'concrete anchor present' },
];

describe('validating-draft output schema', () => {
  it('accepts a verdict with slopFingerprint listing matched patterns', () => {
    const valid = validatingDraftOutputSchema.parse({
      verdict: 'FAIL',
      score: 0.2,
      checks: [
        { name: 'authenticity', result: 'FAIL' as const, detail: 'no first-person token' },
      ],
      issues: ['diagnostic-from-above frame'],
      suggestions: ['rewrite with first-person receipt'],
      slopFingerprint: ['diagnostic_from_above', 'no_first_person', 'fortune_cookie_closer'],
    });
    expect(valid.slopFingerprint).toEqual([
      'diagnostic_from_above',
      'no_first_person',
      'fortune_cookie_closer',
    ]);
  });

  it('treats slopFingerprint as optional with empty default', () => {
    const valid = validatingDraftOutputSchema.parse({
      verdict: 'PASS',
      score: 0.9,
      checks: sampleChecks,
      issues: [],
      suggestions: [],
    });
    expect(valid.slopFingerprint).toEqual([]);
  });

  it('rejects unknown slop pattern IDs', () => {
    expect(() =>
      validatingDraftOutputSchema.parse({
        verdict: 'FAIL',
        score: 0.2,
        checks: sampleChecks,
        issues: [],
        suggestions: [],
        slopFingerprint: ['not_a_real_pattern'],
      }),
    ).toThrow();
  });
});
