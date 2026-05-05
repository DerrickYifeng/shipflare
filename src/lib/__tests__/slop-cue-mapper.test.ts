import { describe, it, expect } from 'vitest';
import { mapSlopFingerprintToVoiceCue, KNOWN_FINGERPRINTS } from '../slop-cue-mapper';

describe('mapSlopFingerprintToVoiceCue', () => {
  it('returns a one-line cue for every known hard-fail fingerprint', () => {
    for (const fp of [
      'diagnostic_from_above',
      'no_first_person',
      'binary_not_x_its_y',
      'preamble_opener',
      'banned_vocabulary',
      'engagement_bait_filler',
    ]) {
      const cue = mapSlopFingerprintToVoiceCue([fp]);
      expect(cue).toBeTruthy();
      expect(cue.length).toBeGreaterThan(10);
      expect(cue.length).toBeLessThan(280);
    }
  });

  it('returns a cue for every known revise-or-tighten fingerprint', () => {
    for (const fp of [
      'fortune_cookie_closer',
      'colon_aphorism_opener',
      'naked_number_unsourced',
      'em_dash_overuse',
      'triple_grouping',
      'negation_cadence',
    ]) {
      expect(mapSlopFingerprintToVoiceCue([fp])).toBeTruthy();
    }
  });

  it('combines cues when multiple fingerprints fire', () => {
    const cue = mapSlopFingerprintToVoiceCue(['preamble_opener', 'fortune_cookie_closer']);
    expect(cue).toContain('opener');
    expect(cue).toContain('closer');
  });

  it('returns a generic cue for empty fingerprint array', () => {
    expect(mapSlopFingerprintToVoiceCue([])).toContain('tighten');
  });

  it('ignores unknown fingerprints (forward-compat)', () => {
    const cue = mapSlopFingerprintToVoiceCue(['unknown_pattern_xyz', 'preamble_opener']);
    expect(cue).toContain('opener');
    expect(cue).not.toContain('unknown_pattern_xyz');
  });

  it('exports the exhaustive list of known fingerprints', () => {
    expect(KNOWN_FINGERPRINTS).toContain('diagnostic_from_above');
    expect(KNOWN_FINGERPRINTS).toContain('em_dash_overuse');
    expect(KNOWN_FINGERPRINTS.length).toBeGreaterThanOrEqual(12);
  });
});
