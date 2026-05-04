// Plan 2 Task 6 — verifies the post-refactor content-manager AGENT.md
// orchestrates via the `process_replies_batch` / `process_posts_batch`
// orchestration Tools, NOT via the `skill` tool calling drafting-* /
// validating-* directly. The full per-item pipeline (judge → draft →
// validate → persist with REVISE retry) lives inside those Tools'
// execute() methods now.
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

describe('content-manager AGENT.md (post-Plan-2-Task-6)', () => {
  it('declares the orchestration Tools that own the per-item pipeline', async () => {
    const cm = await loadContentManager();
    expect(cm.tools).toContain('process_replies_batch');
    expect(cm.tools).toContain('process_posts_batch');
  });

  it('drops the direct `skill` / draft_* / validate_draft access — those are inside the orchestration Tools now', async () => {
    const cm = await loadContentManager();
    expect(cm.tools).not.toContain('skill');
    expect(cm.tools).not.toContain('draft_reply');
    expect(cm.tools).not.toContain('draft_post');
    expect(cm.tools).not.toContain('validate_draft');
  });

  it('drops voice / slop reference docs (now in skills, called inside the Tools)', async () => {
    const cm = await loadContentManager();
    // Reference docs are inlined under "## <name>" headers — assert
    // those are absent rather than re-parsing the frontmatter.
    expect(cm.systemPrompt).not.toContain('## engagement-playbook');
    expect(cm.systemPrompt).not.toContain('## reply-quality-bar');
  });

  it('drops gate-related reference docs (now in judging-opportunity skill, owned by discovery)', async () => {
    const cm = await loadContentManager();
    expect(cm.systemPrompt).not.toContain('## reply-gates');
    expect(cm.systemPrompt).not.toContain('## opportunity-judgment');
  });

  it('the canMentionProduct gate is mentioned as a Tool-enforced rule, not as agent inline logic', async () => {
    const cm = await loadContentManager();
    // Plan 2 Task 6: the agent's hard rules section names the gate so
    // reviewers know discovery's decision is honored, but the *Tool*
    // enforces it — content-manager doesn't re-judge.
    expect(cm.systemPrompt).not.toContain('judging-opportunity');
    expect(cm.systemPrompt).toContain('canMentionProduct');
  });
});
