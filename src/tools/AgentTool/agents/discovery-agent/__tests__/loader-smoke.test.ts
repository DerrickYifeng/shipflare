// Smoke test: discovery-agent AGENT.md loads via the canonical loader,
// the schema is registered, and the declared tools resolve when the
// registry has been populated (xai_find_customers + persist_queue_threads
// are registered later in Phase 7; until then, only StructuredOutput is
// expected to resolve). Per-candidate scoring is now delegated to the
// `judging-thread-quality` skill — `skill` MUST be in the tools list and
// `judgment-rubric` MUST NOT be in shared-references (the skill owns it).

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
        'skill',
        'StructuredOutput',
      ]),
    );
    expect(agent.model).toBe('claude-sonnet-4-6');
    expect(agent.maxTurns).toBe(60);

    // System prompt mentions the conversational loop, the persist call,
    // and now the per-candidate skill the loop delegates scoring to.
    expect(agent.systemPrompt).toMatch(/conversational/i);
    expect(agent.systemPrompt).toMatch(/persist_queue_threads/);
    expect(agent.systemPrompt).toMatch(/reasoning/);
    expect(agent.systemPrompt).toMatch(/judging-thread-quality/);

    // judgment-rubric moved to the judging-thread-quality skill — no
    // longer inlined into this agent's system prompt. The rubric's
    // headline phrase lived under "What \"queue\" means" — assert that
    // distinctive prose is gone from the assembled prompt.
    expect(agent.systemPrompt).not.toMatch(/What "queue" means/);
    expect(agent.systemPrompt).not.toMatch(/Author identity gates/);
  });

  it('registers the output schema', () => {
    const schema = getAgentOutputSchema('discovery-agent');
    expect(schema).toBe(discoveryAgentOutputSchema);
  });
});
