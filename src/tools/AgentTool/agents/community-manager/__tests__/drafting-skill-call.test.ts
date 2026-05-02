// Phase C — verifies the post-refactor community-manager AGENT.md
// orchestrates via the `skill` tool (calling drafting-reply +
// validating-draft) instead of doing drafting / slop review inline.
//
// Uses the same `loadAgentsDir` harness as `loader-smoke.test.ts`
// (project has no `yaml` dependency — the loader's own parser is
// the canonical way to read frontmatter).

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

async function loadCommunityManager() {
  const agents = await loadAgentsDir(AGENTS_ROOT);
  const cm = agents.find((a) => a.name === 'community-manager');
  if (!cm) throw new Error('community-manager not loaded');
  return cm;
}

describe('community-manager AGENT.md (post-Phase-C)', () => {
  it('declares the skill tool so it can call drafting-reply / validating-draft', async () => {
    const cm = await loadCommunityManager();
    expect(cm.tools).toContain('skill');
  });

  it('drops voice / slop reference docs (now in skills)', async () => {
    const cm = await loadCommunityManager();
    // Reference docs are inlined under "## <name>" headers — assert
    // those are absent rather than re-parsing the frontmatter.
    expect(cm.systemPrompt).not.toContain('## engagement-playbook');
    expect(cm.systemPrompt).not.toContain('## reply-quality-bar');
  });

  it('drops gate-related reference docs (now in judging-opportunity skill)', async () => {
    const cm = await loadCommunityManager();
    expect(cm.systemPrompt).not.toContain('## reply-gates');
    expect(cm.systemPrompt).not.toContain('## opportunity-judgment');
  });

  it('directs the agent to call judging-opportunity', async () => {
    const cm = await loadCommunityManager();
    expect(cm.systemPrompt).toContain('judging-opportunity');
  });
});
