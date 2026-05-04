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

    // Plan 2 Task 6: pipeline prose collapsed into process_*_batch
    // Tools — content-manager no longer needs direct skill / draft_*
    // / validate_draft access. The orchestration tools encapsulate the
    // full draft → validate → persist with REVISE retry pipeline.
    expect(cm.tools).toEqual([
      'process_replies_batch',
      'process_posts_batch',
      'find_threads',
      'query_plan_items',
      'query_product_context',
      'SendMessage',
      'StructuredOutput',
    ]);
    expect(cm.model).toBe('claude-haiku-4-5-20251001');
    // Plan 2 Task 6: with the per-item pipeline now inside the batch
    // tools, the agent's own loop is just call-batch-then-summarize.
    // 10 turns is plenty; the prior 100 was a circuit-breaker for the
    // embedded-pipeline era.
    expect(cm.maxTurns).toBe(10);

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

  it('declares both reply and post batch tool patterns', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const cm = agents.find((a) => a.name === 'content-manager');
    expect(cm).toBeDefined();
    if (!cm) return;
    // Plan 2 Task 6: the body now references the orchestration Tools
    // (process_replies_batch / process_posts_batch) instead of the
    // old draft_reply / draft_post + drafting-* skill names.
    expect(cm.systemPrompt).toContain('process_replies_batch');
    expect(cm.systemPrompt).toContain('process_posts_batch');
  });

  it('content-manager AGENT.md no longer embeds pipeline prose', () => {
    const md = readFileSync(
      path.resolve(process.cwd(), 'src/tools/AgentTool/agents/content-manager/AGENT.md'),
      'utf8',
    );
    expect(md).not.toMatch(/Per-item workflow/);
    expect(md).not.toMatch(/1\.\s+\*\*Judge\*\*/);
    expect(md).not.toMatch(/4\.\s+\*\*Slop \/ voice review/);
    expect(md).toContain('process_replies_batch');
    expect(md).toContain('process_posts_batch');
  });

  it('reply pipeline tools own the canMentionProduct check, not the agent', () => {
    const md = readFileSync(
      path.resolve(process.cwd(), 'src/tools/AgentTool/agents/content-manager/AGENT.md'),
      'utf8',
    );
    // judging-opportunity has been gone since Phase J — keep that gate.
    expect(md).not.toContain('judging-opportunity');
    // canMentionProduct is still mentioned in the agent's hard-rules
    // section as something the *Tool* enforces, so the rule itself
    // remains visible to reviewers.
    expect(md).toContain('canMentionProduct');
  });
});
