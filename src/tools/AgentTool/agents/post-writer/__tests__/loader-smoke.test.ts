// Smoke test: the post-writer AGENT.md loads via the canonical loader
// path. Phase E thinned the agent to orchestration only — drafting
// logic + voice references moved to the `drafting-post` skill.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

describe('post-writer loader smoke', () => {
  it('loads post-writer with the orchestration tool list', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = agents.map((a) => a.name).sort();
    expect(names).toContain('post-writer');

    const writer = agents.find((a) => a.name === 'post-writer');
    expect(writer).toBeDefined();
    if (!writer) return;

    // Thinned tool list — no SendMessage; `skill` replaces inline drafting.
    expect(writer.tools).toEqual([
      'query_plan_items',
      'query_product_context',
      'skill',
      'validate_draft',
      'draft_post',
      'StructuredOutput',
    ]);
    expect(writer.model).toBe('claude-sonnet-4-6');
    // Bumped down from 12 → 6 because the agent only orchestrates now;
    // drafting itself happens in the forked drafting-post skill.
    expect(writer.maxTurns).toBe(6);

    // No inlined references — voice + safety guides moved to the
    // drafting-post skill where they belong.
    expect(writer.systemPrompt).not.toContain('## x-content-guide');
    expect(writer.systemPrompt).not.toContain('## reddit-content-guide');
    expect(writer.systemPrompt).not.toContain('## content-safety');

    // The orchestration prompt mentions the skill name explicitly so
    // the agent knows what to invoke.
    expect(writer.systemPrompt).toContain('drafting-post');
  });

  it('the legacy x-writer + reddit-writer agents are gone', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = new Set(agents.map((a) => a.name));
    expect(names.has('x-writer')).toBe(false);
    expect(names.has('reddit-writer')).toBe(false);
  });
});
