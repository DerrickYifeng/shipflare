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

  it('accepts all 12 slop pattern IDs in a single fingerprint', () => {
    const allIds = [
      'diagnostic_from_above',
      'no_first_person',
      'fortune_cookie_closer',
      'colon_aphorism_opener',
      'naked_number_unsourced',
      'em_dash_overuse',
      'binary_not_x_its_y',
      'preamble_opener',
      'banned_vocabulary',
      'triple_grouping',
      'negation_cadence',
      'engagement_bait_filler',
    ];
    const valid = validatingDraftOutputSchema.parse({
      verdict: 'FAIL',
      score: 0.0,
      checks: sampleChecks,
      issues: [],
      suggestions: [],
      slopFingerprint: allIds,
    });
    expect(valid.slopFingerprint).toHaveLength(12);
  });

  it('default empty array is a fresh instance per parse (no shared state)', () => {
    const a = validatingDraftOutputSchema.parse({
      verdict: 'PASS',
      score: 0.9,
      checks: sampleChecks,
      issues: [],
      suggestions: [],
    });
    const b = validatingDraftOutputSchema.parse({
      verdict: 'PASS',
      score: 0.9,
      checks: sampleChecks,
      issues: [],
      suggestions: [],
    });
    // Mutating a's default array MUST NOT bleed into b's
    a.slopFingerprint.push('diagnostic_from_above' as never);
    expect(b.slopFingerprint).toEqual([]);
  });
});
