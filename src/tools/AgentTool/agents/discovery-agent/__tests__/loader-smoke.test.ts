// Smoke test: discovery-agent AGENT.md loads via the canonical loader,
// the schema is registered, and the declared tools resolve when the
// registry has been populated (xai_find_customers + persist_queue_threads
// are registered later in Phase 7; until then, only StructuredOutput is
// expected to resolve).

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';
import { getAgentOutputSchema } from '@/tools/AgentTool/agent-schemas';
import { discoveryAgentOutputSchema } from '../schema';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

describe('discovery-agent loader smoke', () => {
  it('loads discovery-agent with frontmatter intact', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = agents.map((a) => a.name);
    expect(names).toContain('discovery-agent');

    const agent = agents.find((a) => a.name === 'discovery-agent');
    expect(agent).toBeDefined();
    if (!agent) return;

    expect(agent.tools).toEqual(
      expect.arrayContaining([
        'xai_find_customers',
        'persist_queue_threads',
        'StructuredOutput',
      ]),
    );
    expect(agent.model).toBe('claude-sonnet-4-6');
    expect(agent.maxTurns).toBe(60);

    // System prompt mentions the conversational loop and persist call.
    expect(agent.systemPrompt).toMatch(/conversational/i);
    expect(agent.systemPrompt).toMatch(/persist_queue_threads/);
    expect(agent.systemPrompt).toMatch(/reasoning/);
  });

  it('registers the output schema', () => {
    const schema = getAgentOutputSchema('discovery-agent');
    expect(schema).toBe(discoveryAgentOutputSchema);
  });
});
