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
 * Phase 6 (agent-cleanup) trimmed the catalog to the single skill that
 * still runs via `runSkill()`: voice-extractor (consumed by the
 * voice-extract worker for the `setup_task` plan_item route). All other
 * former entries were either deleted (draft-single-reply, absorbed into
 * community-manager) or migrated to direct `runAgent(loadAgentFromFile())`
 * calls against the unified registry under `src/tools/AgentTool/agents/`.
 */
describe('SKILL_CATALOG', () => {
  const SKILLS_DIR = join(process.cwd(), 'src/skills');

  it('exports the single runtime-loaded skill that survived agent-cleanup phase 6', () => {
    const names = SKILL_CATALOG.map((s) => s.name);
    expect(names).toEqual(['voice-extractor']);
    expect(names).not.toContain('discovery');
    expect(names).not.toContain('posting');
    expect(names).not.toContain('draft-review');
    expect(names).not.toContain('draft-single-reply');
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
    const entry = findSkill('voice-extractor');
    expect(entry).toBeDefined();
    expect(entry?.name).toBe('voice-extractor');
  });

  it('returns undefined for an unknown skill name', () => {
    expect(findSkill('does-not-exist')).toBeUndefined();
  });

  it('returns undefined for the deleted draft-single-reply skill', () => {
    expect(findSkill('draft-single-reply')).toBeUndefined();
  });
});

describe('skillsForKind', () => {
  it('returns no catalog skill for content_reply on x — community-manager owns this end-to-end', () => {
    // Phase 6: community-manager team-run agent handles content_reply
    // drafting itself; no catalog-registered skill matches.
    const matches = skillsForKind('content_reply', 'x');
    expect(matches).toEqual([]);
  });

  it('returns no catalog skill for content_reply on reddit', () => {
    const matches = skillsForKind('content_reply', 'reddit');
    expect(matches).toEqual([]);
  });

  it('includes channel-agnostic skills for any channel', () => {
    const matches = skillsForKind('setup_task', 'x');
    // voice-extractor has no channels field → must match every channel.
    expect(matches.map((s) => s.name)).toContain('voice-extractor');
  });

  it('returns an empty array when no catalog skill supports the requested kind', () => {
    // content_post flows through the post-writer team-run, not a
    // catalog-registered skill — so catalog lookup for this kind is
    // deliberately empty.
    const matches = skillsForKind('content_post');
    expect(matches).toEqual([]);
  });
});
