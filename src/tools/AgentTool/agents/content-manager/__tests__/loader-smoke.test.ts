// Smoke test: the content-manager AGENT.md (+ references) loads via
// the canonical loader path with references inlined. Phase J renamed
// the agent from `community-manager` to `content-manager` and extended
// it to handle both reply_sweep and post_batch input modes.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
    // Phase J Day 6 raised this from 12 — batch post_batch with N items
    // and per-item retry can exceed 12 turns; 100 is a circuit-breaker
    // ceiling, agents should StructuredOutput long before.
    expect(cm.maxTurns).toBe(100);

    // Per-agent references are gone after Phase D — gate logic lives
    // in the `judging-opportunity` skill, voice/slop logic lives in
    // the `drafting-reply` / `validating-draft` skills.
    expect(cm.systemPrompt).not.toContain('## reply-gates');
    expect(cm.systemPrompt).not.toContain('## opportunity-judgment');
    expect(cm.systemPrompt).not.toContain('## engagement-playbook');
    expect(cm.systemPrompt).not.toContain('## reply-quality-bar');

    // Judging is now owned by discovery (judging-thread-quality at queue
    // time). content-manager reads `canMentionProduct` + `mentionSignal`
    // off the thread row instead of re-judging.
    expect(cm.systemPrompt).not.toContain('judging-opportunity');
    expect(cm.systemPrompt).toContain('canMentionProduct');

    // Shared reference (base-guidelines) also inlined.
    expect(cm.systemPrompt).toContain('## base-guidelines');
  });

  it('loads cleanly alongside the other registered agents', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = agents.map((a) => a.name).sort();
    // content-manager (renamed from community-manager in Phase J).
    expect(names).toContain('content-manager');
    expect(names).not.toContain('community-manager');
    // post-writer was retired in Phase J Task 2 — content-manager
    // handles original posts via post_batch mode now.
    expect(names).not.toContain('post-writer');
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

  it('reply_sweep workflow no longer calls judging-opportunity', () => {
    const md = readFileSync(
      path.resolve(process.cwd(), 'src/tools/AgentTool/agents/content-manager/AGENT.md'),
      'utf8',
    );
    expect(md).not.toContain('judging-opportunity');
    expect(md).toContain('canMentionProduct'); // reads it from the thread row
  });
});
