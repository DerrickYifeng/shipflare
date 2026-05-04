// Smoke test: discovery-agent AGENT.md loads via the canonical loader,
// the schema is registered, and the declared tools resolve. Plan 2 Task
// 6 collapsed the embedded conversational xAI loop into the
// `find_threads_via_xai` Tool — the agent's tool list is now
// `find_threads_via_xai` + `read_memory` + `StructuredOutput`, and the
// previously-inlined "Mode: ..." / "Steps: 1. ..." / "Compose a user
// message describing what you want xAI to find" prose is gone.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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

    // Plan 2 Task 6: tool list collapsed — the conversational xAI
    // loop, per-candidate judging, and persistence now all live inside
    // `find_threads_via_xai`. The agent no longer needs `skill`,
    // `xai_find_customers`, or `persist_queue_threads` directly.
    expect(agent.tools).toEqual([
      'find_threads_via_xai',
      'read_memory',
      'StructuredOutput',
    ]);
    expect(agent.model).toBe('claude-sonnet-4-6');
    // Plan 2 Task 6: with the loop inside the tool, the agent only
    // needs ~3 turns (read rubric → call tool → emit StructuredOutput).
    // 4 is a small buffer; the prior 60 was for the embedded loop.
    expect(agent.maxTurns).toBe(4);

    // System prompt still names the surface tools and the canonical
    // mention-judgment field carried through to persistence.
    expect(agent.systemPrompt).toMatch(/find_threads_via_xai/);
    expect(agent.systemPrompt).toMatch(/read_memory/);

    // The conversational xAI prose ("Compose a user message...",
    // "Mode: ...", "Steps: 1. ...") that used to live inline is gone.
    expect(agent.systemPrompt).not.toMatch(
      /Compose a user message describing what you want xAI to find/,
    );
    expect(agent.systemPrompt).not.toMatch(/What "queue" means/);
    expect(agent.systemPrompt).not.toMatch(/Author identity gates/);
  });

  it('registers the output schema', () => {
    const schema = getAgentOutputSchema('discovery-agent');
    expect(schema).toBe(discoveryAgentOutputSchema);
  });

  it('discovery-agent AGENT.md no longer embeds the conversational xAI loop prose', () => {
    const md = readFileSync(
      path.resolve(
        process.cwd(),
        'src/tools/AgentTool/agents/discovery-agent/AGENT.md',
      ),
      'utf8',
    );
    expect(md).not.toMatch(/Compose a user message describing what you want xAI to find/);
    expect(md).not.toMatch(/^Mode:/m);
    expect(md).not.toMatch(/Steps:\s*\n1\./m);
    expect(md).toContain('find_threads_via_xai');
  });
});
