// Smoke test: the community-manager AGENT.md (+ references) loads via
// the canonical loader path with references inlined.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

describe('community-manager loader smoke', () => {
  it('loads community-manager with references inlined', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = agents.map((a) => a.name).sort();
    expect(names).toContain('community-manager');

    const cm = agents.find((a) => a.name === 'community-manager');
    expect(cm).toBeDefined();
    if (!cm) return;

    // Tool allowlist after Phase C: orchestrator-only tools, plus the
    // `skill` tool so the agent can call drafting-reply / validating-draft.
    expect(cm.tools).toEqual([
      'find_threads',
      'skill',
      'validate_draft',
      'draft_reply',
      'SendMessage',
      'StructuredOutput',
    ]);
    expect(cm.model).toBe('claude-haiku-4-5-20251001');
    expect(cm.maxTurns).toBe(12);

    // Per-agent references inlined under "## <name>" headers.
    expect(cm.systemPrompt).toContain('## reply-gates');
    expect(cm.systemPrompt).toContain('## opportunity-judgment');
    expect(cm.systemPrompt).toContain('three-gate');

    // Voice / slop reference docs are gone — they live in the skills now.
    expect(cm.systemPrompt).not.toContain('## engagement-playbook');
    expect(cm.systemPrompt).not.toContain('## reply-quality-bar');

    // Shared reference (base-guidelines) also inlined.
    expect(cm.systemPrompt).toContain('## base-guidelines');
  });

  it('loads cleanly alongside the other writer/community agents', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = agents.map((a) => a.name).sort();
    // The unified post-writer + community-manager pair.
    expect(names).toContain('post-writer');
    expect(names).toContain('community-manager');
    // And the baseline planner/strategist agents.
    expect(names).toContain('coordinator');
    expect(names).toContain('growth-strategist');
    expect(names).toContain('content-planner');
  });
});
