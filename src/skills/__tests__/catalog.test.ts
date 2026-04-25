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
 * Phase E Day 3 trimmed the catalog from 22 to 5 entries — the remaining
 * entries are the skills still loaded at runtime by their workers. The v2
 * atomic-skill set that the tactical-planner used to select via skillName
 * is gone; plan_items now flow through team-run coordinators + Task-spawned
 * writer agents, so the planner no longer drives a catalog lookup.
 */
describe('SKILL_CATALOG', () => {
  const SKILLS_DIR = join(process.cwd(), 'src/skills');

  it('exports the 4 runtime-loaded skills that survived Discovery v3', () => {
    const names = SKILL_CATALOG.map((s) => s.name);
    for (const required of [
      'draft-single-reply',
      'draft-review',
      'posting',
      'voice-extractor',
    ]) {
      expect(names).toContain(required);
    }
    expect(names).not.toContain('discovery');
  });

  it('has a unique name per entry', () => {
    const names = SKILL_CATALOG.map((s) => s.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('every entry carries a parseable Zod input schema', () => {
    for (const entry of SKILL_CATALOG) {
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
    const entry = findSkill('draft-single-reply');
    expect(entry).toBeDefined();
    expect(entry?.name).toBe('draft-single-reply');
  });

  it('returns undefined for an unknown skill name', () => {
    expect(findSkill('does-not-exist')).toBeUndefined();
  });
});

describe('skillsForKind', () => {
  it('returns draft-single-reply for content_reply on x', () => {
    const matches = skillsForKind('content_reply', 'x');
    expect(matches.map((s) => s.name)).toContain('draft-single-reply');
  });

  it('excludes channel-scoped skills for other channels', () => {
    const matches = skillsForKind('content_reply', 'reddit');
    // draft-single-reply advertises channels: ['x'] only; it should not match.
    expect(matches.map((s) => s.name)).not.toContain('draft-single-reply');
  });

  it('includes channel-agnostic skills for any channel', () => {
    const matches = skillsForKind('setup_task', 'x');
    // voice-extractor has no channels field → must match every channel.
    expect(matches.map((s) => s.name)).toContain('voice-extractor');
  });

  it('returns an empty array when no catalog skill supports the requested kind', () => {
    // content_post flows through team-run writers (x-writer / reddit-writer),
    // not a catalog-registered skill — so catalog lookup for this kind is
    // deliberately empty.
    const matches = skillsForKind('content_post');
    expect(matches).toEqual([]);
  });
});
