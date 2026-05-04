// Phase C — verifies the post-refactor content-manager AGENT.md
// (renamed from `community-manager` in Phase J) orchestrates via the
// `skill` tool (calling drafting-reply / drafting-post +
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

async function loadContentManager() {
  const agents = await loadAgentsDir(AGENTS_ROOT);
  const cm = agents.find((a) => a.name === 'content-manager');
  if (!cm) throw new Error('content-manager not loaded');
  return cm;
}

describe('content-manager AGENT.md (post-Phase-J)', () => {
  it('declares the skill tool so it can call drafting-reply / drafting-post / validating-draft', async () => {
    const cm = await loadContentManager();
    expect(cm.tools).toContain('skill');
  });

  it('drops voice / slop reference docs (now in skills)', async () => {
    const cm = await loadContentManager();
    // Reference docs are inlined under "## <name>" headers — assert
    // those are absent rather than re-parsing the frontmatter.
    expect(cm.systemPrompt).not.toContain('## engagement-playbook');
    expect(cm.systemPrompt).not.toContain('## reply-quality-bar');
  });

  it('drops gate-related reference docs (now in judging-opportunity skill)', async () => {
    const cm = await loadContentManager();
    expect(cm.systemPrompt).not.toContain('## reply-gates');
    expect(cm.systemPrompt).not.toContain('## opportunity-judgment');
  });

  it('reads judging from the thread row instead of re-running judging-opportunity', async () => {
    const cm = await loadContentManager();
    // Discovery's judging-thread-quality skill writes canMentionProduct +
    // mentionSignal onto the thread at queue time; content-manager must
    // not re-judge.
    expect(cm.systemPrompt).not.toContain('judging-opportunity');
    expect(cm.systemPrompt).toContain('canMentionProduct');
    expect(cm.systemPrompt).toContain('mentionSignal');
  });
});
