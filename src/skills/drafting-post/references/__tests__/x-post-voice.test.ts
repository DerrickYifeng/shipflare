// Structural tests for the X post-voice guide. The drafting-post skill
// relies on six phase subsections (one per LaunchPhase value), five
// named voice clusters, and three named steady-phase sub-modes. These
// tests catch accidental section deletion / typos that would silently
// mismatch the SKILL.md vocabulary.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const GUIDE_PATH = path.resolve(
  process.cwd(),
  'src/skills/drafting-post/references/x-post-voice.md',
);

const PHASES = [
  'foundation',
  'audience',
  'momentum',
  'launch',
  'compound',
  'steady',
] as const;

const VOICE_CLUSTERS = [
  'terse_shipper',
  'vulnerable_philosopher',
  'daily_vlogger',
  'patient_grinder',
  'contrarian_analyst',
] as const;

const STEADY_SUBMODES = [
  'revenue_flex',
  'contrarian_teacher',
  'sunset',
] as const;

describe('x-post-voice.md structural integrity', () => {
  let guide: string;
  beforeAll(async () => {
    guide = await fs.readFile(GUIDE_PATH, 'utf-8');
  });

  it('contains a top-level "Output contract" section', () => {
    expect(guide).toMatch(/##\s+1\.\s+Output contract/i);
  });

  it('contains a "Universal rules" section enumerating the four hard rules', () => {
    expect(guide).toMatch(/##\s+2\.\s+Universal rules/i);
    expect(guide).toMatch(/280 weighted/i);
    expect(guide).toMatch(/sibling[- ]platform/i);
    expect(guide).toMatch(/unsourced numeric/i);
  });

  it('contains a "Banned openers" section listing all banned phrases', () => {
    expect(guide).toMatch(/##\s+3\.\s+Banned openers/i);
    for (const phrase of [
      // Banned openers
      'Excited to announce',
      'Excited to share',
      'Big news!',
      'Quick update:',
      'Just wanted to say',
      'Hey friends,',
      "I'm thrilled to",
      // Banned begging phrases
      'please RT',
      'support means everything',
      'any feedback appreciated',
      'RT if you like it',
      'would mean a lot',
    ]) {
      expect(guide).toContain(phrase);
    }
  });

  it('defines all 5 voice clusters in §4', () => {
    expect(guide).toMatch(/##\s+4\.\s+Voice clusters/i);
    for (const cluster of VOICE_CLUSTERS) {
      expect(guide).toContain(cluster);
    }
  });

  it('contains a default-voice-per-phase mapping for every phase', () => {
    for (const phase of PHASES) {
      // Each phase row in §4's defaults table mentions the phase name.
      const re = new RegExp(`\\b${phase}\\b`, 'i');
      expect(guide).toMatch(re);
    }
  });

  it('contains a phase subsection for each LaunchPhase under §5', () => {
    for (const phase of PHASES) {
      // Match e.g. "### 5.1 foundation" — number is flexible, name is fixed.
      const re = new RegExp(`###\\s+5\\.\\d+\\s+${phase}\\b`, 'i');
      expect(guide).toMatch(re);
    }
  });

  it('every phase subsection declares Default voice / Objective / Templates', () => {
    for (const phase of PHASES) {
      const sectionStart = guide.search(
        new RegExp(`###\\s+5\\.\\d+\\s+${phase}\\b`, 'i'),
      );
      expect(sectionStart, `${phase} subsection missing`).toBeGreaterThan(-1);
      // Walk to the end of this subsection (next "### " header or end of file).
      const remainder = guide.slice(sectionStart + 1);
      const nextHeaderIdx = remainder.search(/\n##+\s/);
      const section =
        nextHeaderIdx === -1 ? remainder : remainder.slice(0, nextHeaderIdx);

      expect(section).toMatch(/Default voice/i);
      expect(section).toMatch(/Objective/i);
      expect(section).toMatch(/Templates?/i);
    }
  });

  it('the steady subsection names all three sub-modes', () => {
    const steadyStart = guide.search(/###\s+5\.\d+\s+steady\b/i);
    expect(steadyStart).toBeGreaterThan(-1);
    const remainder = guide.slice(steadyStart + 1);
    const nextHeaderIdx = remainder.search(/\n##\s/);
    const section =
      nextHeaderIdx === -1 ? remainder : remainder.slice(0, nextHeaderIdx);

    for (const mode of STEADY_SUBMODES) {
      expect(section).toContain(mode);
    }
  });

  it('contains a "Bad vs good examples" section', () => {
    expect(guide).toMatch(/##\s+6\.\s+Bad vs good/i);
  });
});
