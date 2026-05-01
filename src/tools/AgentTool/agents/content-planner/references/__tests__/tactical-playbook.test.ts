// Structural tests for the tactical-playbook reference. The smarter
// content-planner relies on a "Pillar mix and metaphor ban" section
// that lists the closed 5-pillar vocabulary and the per-channel cap
// rule. These tests catch accidental section deletion or rewording
// that would silently break the planner's instructions.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const PLAYBOOK_PATH = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents/content-planner/references/tactical-playbook.md',
);

const PILLARS = [
  'milestone',
  'lesson',
  'hot_take',
  'behind_the_scenes',
  'question',
] as const;

describe('tactical-playbook.md structural integrity', () => {
  let playbook: string;
  beforeAll(async () => {
    playbook = await fs.readFile(PLAYBOOK_PATH, 'utf-8');
  });

  it('contains a "Pillar mix and metaphor ban" section', () => {
    expect(playbook).toMatch(/##\s+Pillar mix and metaphor ban/i);
  });

  it('lists all 5 pillars verbatim in the new section', () => {
    for (const pillar of PILLARS) {
      expect(playbook).toContain(pillar);
    }
  });

  it('states the per-channel hard cap rule', () => {
    // The cap is "≤ 2 of any pillar per channel" — accept either the
    // ≤ glyph or the ASCII "<= 2" / "max 2".
    expect(playbook).toMatch(/(≤\s*2|max\s*2|<=\s*2).*per channel/i);
  });

  it('references the query_recent_x_posts tool by name', () => {
    expect(playbook).toContain('query_recent_x_posts');
  });

  it('mentions the 14-day look-back window', () => {
    expect(playbook).toMatch(/14[-\s]?days?|days:\s*14/i);
  });
});
