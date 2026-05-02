// Smoke test: the coordinator AGENT.md (+ references) loads via the
// canonical loader path with references inlined. Phase J Day 5
// removed the unrestricted `skill` tool from coordinator's allowlist
// and replaced its single legitimate use case (generating-strategy
// invocation) with the purpose-built `generate_strategic_path` tool.
//
// Background: with `skill` in the allowlist, the LLM freelanced —
// calling `drafting-reply` and `judging-thread-quality` directly,
// pasting raw JSON output as user-facing synthesis text, producing
// "phantom drafts" that never persisted. Locking the tool list at
// the loader level prevents the regression at the smoke-test gate.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

describe('coordinator loader smoke', () => {
  it('loads coordinator with the post-Phase-J tools list (no `skill`, has `generate_strategic_path`)', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const coord = agents.find((a) => a.name === 'coordinator');
    expect(coord).toBeDefined();
    if (!coord) return;

    expect(coord.tools).not.toContain('skill');
    expect(coord.tools).toContain('generate_strategic_path');
    expect(coord.tools).toContain('Task');
    expect(coord.tools).toContain('SendMessage');
  });

  it('inlines the synthesis hard rules into the system prompt', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const coord = agents.find((a) => a.name === 'coordinator');
    expect(coord).toBeDefined();
    if (!coord) return;

    // Hard rule §1 — synthesize, never paste
    expect(coord.systemPrompt).toMatch(/synthesize/i);
    expect(coord.systemPrompt).toMatch(/never paste/i);

    // Hard rule §2 — drafting belongs to specialists. The model needs
    // to see the explicit "you do NOT have the skill tool" signal so it
    // doesn't hallucinate the call.
    expect(coord.systemPrompt).toMatch(/do NOT have the `skill` tool/);
  });
});
