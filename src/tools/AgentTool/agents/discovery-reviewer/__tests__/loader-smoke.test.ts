// Smoke test: discovery-reviewer AGENT.md + references load via the
// canonical loader path, the schema is registered, and the declared
// tools (StructuredOutput only) resolve at runAgent spawn time.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';
import { getAgentOutputSchema } from '@/tools/AgentTool/agent-schemas';
import { discoveryReviewerOutputSchema } from '../schema';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

describe('discovery-reviewer loader smoke', () => {
  it('loads discovery-reviewer with frontmatter and references inlined', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = agents.map((a) => a.name);
    expect(names).toContain('discovery-reviewer');

    const reviewer = agents.find((a) => a.name === 'discovery-reviewer');
    expect(reviewer).toBeDefined();
    if (!reviewer) return;

    expect(reviewer.tools).toEqual(['StructuredOutput']);
    expect(reviewer.model).toBe('claude-sonnet-4-6');
    expect(reviewer.maxTurns).toBe(5);

    // Both per-agent references inlined.
    expect(reviewer.systemPrompt).toContain('## reviewer-guidelines');
    expect(reviewer.systemPrompt).toContain('Your default is skip');
    expect(reviewer.systemPrompt).toContain('## judgment-rubric');

    // Shared reference injected.
    expect(reviewer.systemPrompt).toContain('## base-guidelines');
  });

  it('registers its output schema in the agent-schemas registry', () => {
    const schema = getAgentOutputSchema('discovery-reviewer');
    expect(schema).not.toBeNull();
    expect(schema).toBe(discoveryReviewerOutputSchema);
  });

  it('scout and reviewer share the judgment-rubric reference but diverge on guidance', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const scout = agents.find((a) => a.name === 'discovery-scout');
    const reviewer = agents.find((a) => a.name === 'discovery-reviewer');
    expect(scout).toBeDefined();
    expect(reviewer).toBeDefined();
    if (!scout || !reviewer) return;

    // Both carry the shared rubric.
    expect(scout.systemPrompt).toContain('## judgment-rubric');
    expect(reviewer.systemPrompt).toContain('## judgment-rubric');

    // Only reviewer carries the adversarial guidelines.
    expect(reviewer.systemPrompt).toContain('## reviewer-guidelines');
    expect(scout.systemPrompt).not.toContain('## reviewer-guidelines');

    // System prompts are not identical (divergent role descriptions).
    expect(scout.systemPrompt).not.toEqual(reviewer.systemPrompt);
  });
});
