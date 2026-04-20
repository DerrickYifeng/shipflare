import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  SKILL_CATALOG,
  findSkill,
  skillsForKind,
} from '../_catalog';

/**
 * The catalog is the contract between the tactical-planner (Phase 6) and the
 * plan-execute dispatcher (Phase 7). These tests pin the invariants every
 * downstream consumer assumes: entries are unique, schemas are valid Zod, and
 * each entry corresponds to a real SKILL.md frontmatter name on disk.
 */
describe('SKILL_CATALOG', () => {
  const SKILLS_DIR = join(process.cwd(), 'src/skills');

  it('exports at least the six skills required by the Phase 4 exit gate', () => {
    const names = SKILL_CATALOG.map((s) => s.name);
    for (const required of [
      'draft-single-post',
      'draft-single-reply',
      'discovery',
      'draft-review',
      'posting',
      'voice-extractor',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('has a unique name per entry', () => {
    const names = SKILL_CATALOG.map((s) => s.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('every entry carries a parseable Zod input schema', () => {
    for (const entry of SKILL_CATALOG) {
      // `ZodType.parse(undefined)` either succeeds (empty object with all
      // optional fields) or throws — both are valid Zod signals. What we're
      // guarding against is a non-Zod value slipped into `inputSchema`.
      expect(typeof entry.inputSchema).toBe('object');
      expect(entry.inputSchema).toBeInstanceOf(z.ZodType);
    }
  });

  it('every entry whose outputSchema is declared exposes a Zod schema', () => {
    for (const entry of SKILL_CATALOG) {
      if (entry.outputSchema === undefined) continue;
      expect(entry.outputSchema).toBeInstanceOf(z.ZodType);
    }
  });

  it('every entry resolves to a SKILL.md on disk with a matching name', () => {
    for (const entry of SKILL_CATALOG) {
      const skillMdPath = join(SKILLS_DIR, entry.name, 'SKILL.md');
      expect(
        existsSync(skillMdPath),
        `missing SKILL.md for ${entry.name} at ${skillMdPath}`,
      ).toBe(true);

      const raw = readFileSync(skillMdPath, 'utf-8');
      const nameMatch = raw.match(/^name:\s*(.+)$/m);
      expect(nameMatch, `SKILL.md for ${entry.name} has no name frontmatter`).not.toBeNull();
      expect(nameMatch![1].trim()).toBe(entry.name);
    }
  });

  it('channels entries are non-empty when declared', () => {
    for (const entry of SKILL_CATALOG) {
      if (entry.channels === undefined) continue;
      expect(entry.channels.length).toBeGreaterThan(0);
    }
  });
});

describe('findSkill', () => {
  it('returns the catalog entry by exact name', () => {
    const entry = findSkill('draft-single-post');
    expect(entry).toBeDefined();
    expect(entry?.name).toBe('draft-single-post');
  });

  it('returns undefined for an unknown skill name', () => {
    expect(findSkill('does-not-exist')).toBeUndefined();
  });
});

describe('skillsForKind', () => {
  it('returns draft-single-post for content_post on x', () => {
    const matches = skillsForKind('content_post', 'x');
    expect(matches.map((s) => s.name)).toContain('draft-single-post');
  });

  it('excludes channel-scoped skills for other channels', () => {
    const matches = skillsForKind('content_post', 'reddit');
    // draft-single-post advertises channels: ['x'] only until Phase 5
    // lands Reddit; it should not match here.
    expect(matches.map((s) => s.name)).not.toContain('draft-single-post');
  });

  it('includes channel-agnostic skills for any channel', () => {
    const matches = skillsForKind('setup_task', 'x');
    // voice-extractor has no channels field → must match every channel.
    expect(matches.map((s) => s.name)).toContain('voice-extractor');
  });

  it('returns an empty array when no skill supports the requested kind', () => {
    // metrics_compute has no catalog entry today — it lands in Phase 5.
    const matches = skillsForKind('metrics_compute');
    expect(matches).toEqual([]);
  });
});
