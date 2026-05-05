// Structural tests for the allocation-rules reference. The
// allocating-plan-items skill relies on a "Format mix and metaphor ban"
// section that lists the closed 5-format vocabulary and the
// per-channel cap rule. These tests catch accidental section deletion
// or rewording that would silently break the planner's instructions.
// (Renamed from "pillar" to "format" 2026-05-04 — see schemas.ts.)
//
// Ported from src/tools/AgentTool/agents/content-planner/references/__tests__/tactical-playbook.test.ts
// during Phase G of the agent-skill-tool decomposition.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const RULES_PATH = path.resolve(
  process.cwd(),
  'src/skills/allocating-plan-items/references/allocation-rules.md',
);

const FORMATS = [
  'milestone',
  'lesson',
  'hot_take',
  'behind_the_scenes',
  'question',
] as const;

describe('allocation-rules.md structural integrity', () => {
  let rules: string;
  beforeAll(async () => {
    rules = await fs.readFile(RULES_PATH, 'utf-8');
  });

  it('contains a "Format mix and metaphor ban" section', () => {
    expect(rules).toMatch(/##\s+Format mix and metaphor ban/i);
  });

  it('lists all 5 formats verbatim in the new section', () => {
    for (const format of FORMATS) {
      expect(rules).toContain(format);
    }
  });

  it('states the per-channel hard cap rule', () => {
    // The cap is "≤ 2 of any format per channel" — accept either the
    // ≤ glyph or the ASCII "<= 2" / "max 2".
    expect(rules).toMatch(/(≤\s*2|max\s*2|<=\s*2).*per channel/i);
  });

  it('mentions the 14-day look-back window', () => {
    expect(rules).toMatch(/14[-\s]?days?|days:\s*14/i);
  });
});
