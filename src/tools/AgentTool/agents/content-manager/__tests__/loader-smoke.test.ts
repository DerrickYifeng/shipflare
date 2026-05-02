// Smoke test: the content-manager AGENT.md (+ references) loads via
// the canonical loader path with references inlined. Phase J renamed
// the agent from `community-manager` to `content-manager` and extended
// it to handle both reply_sweep and post_batch input modes.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

describe('content-manager loader smoke', () => {
  it('loads content-manager with references inlined', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = agents.map((a) => a.name).sort();
    expect(names).toContain('content-manager');

    const cm = agents.find((a) => a.name === 'content-manager');
    expect(cm).toBeDefined();
    if (!cm) return;

    // Phase J tool allowlist: orchestrator-only tools, plus skill +
    // the post_batch-supporting query / draft tools so the agent can
    // pull plan_items + product context and persist post drafts.
    expect(cm.tools).toEqual([
      'find_threads',
      'query_plan_items',
      'query_product_context',
      'skill',
      'validate_draft',
      'draft_reply',
      'draft_post',
      'SendMessage',
      'StructuredOutput',
    ]);
    expect(cm.model).toBe('claude-haiku-4-5-20251001');
    expect(cm.maxTurns).toBe(12);

    // Per-agent references are gone after Phase D — gate logic lives
    // in the `judging-opportunity` skill, voice/slop logic lives in
    // the `drafting-reply` / `validating-draft` skills.
    expect(cm.systemPrompt).not.toContain('## reply-gates');
    expect(cm.systemPrompt).not.toContain('## opportunity-judgment');
    expect(cm.systemPrompt).not.toContain('## engagement-playbook');
    expect(cm.systemPrompt).not.toContain('## reply-quality-bar');

    // The agent now orchestrates the judging-opportunity skill instead.
    expect(cm.systemPrompt).toContain('judging-opportunity');

    // Shared reference (base-guidelines) also inlined.
    expect(cm.systemPrompt).toContain('## base-guidelines');
  });

  it('loads cleanly alongside the other writer/community agents', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = agents.map((a) => a.name).sort();
    // The unified post-writer + content-manager pair (community-manager
    // was renamed in Phase J).
    expect(names).toContain('post-writer');
    expect(names).toContain('content-manager');
    expect(names).not.toContain('community-manager');
    // And the baseline planner agents. (`growth-strategist` was
    // converted to the `generating-strategy` fork-mode skill in Phase F
    // and is no longer loaded from src/tools/AgentTool/agents/.)
    expect(names).toContain('coordinator');
    expect(names).toContain('content-planner');
    expect(names).not.toContain('growth-strategist');
  });

  it('declares both reply_sweep and post_batch input modes', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const cm = agents.find((a) => a.name === 'content-manager');
    expect(cm).toBeDefined();
    if (!cm) return;
    // Phase J body covers both flows. Assert the mode names + the
    // per-flow draft skill names appear in the system prompt so a
    // future edit that drops a section trips this test.
    expect(cm.systemPrompt).toContain('reply_sweep');
    expect(cm.systemPrompt).toContain('post_batch');
    expect(cm.systemPrompt).toContain('drafting-reply');
    expect(cm.systemPrompt).toContain('drafting-post');
    expect(cm.systemPrompt).toContain('draft_post');
    expect(cm.systemPrompt).toContain('draft_reply');
  });
});
