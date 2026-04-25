// Smoke test: reply-drafter AGENT.md + references load via the canonical
// loader path, the drafter schema is registered, and the declared tools
// exist in the central registry (so Task-spawning the agent won't fail
// with an unresolved allowed-tools entry).

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';
import { getAgentOutputSchema } from '@/tools/AgentTool/agent-schemas';
import { registry as toolRegistry } from '@/tools/registry';
import { replyDrafterOutputSchema } from '../schema';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

describe('reply-drafter loader smoke', () => {
  it('loads reply-drafter with frontmatter and references inlined', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = agents.map((a) => a.name);
    expect(names).toContain('reply-drafter');

    const drafter = agents.find((a) => a.name === 'reply-drafter');
    expect(drafter).toBeDefined();
    if (!drafter) return;

    expect(drafter.tools).toEqual(['draft_single_reply', 'StructuredOutput']);
    expect(drafter.model).toBe('claude-haiku-4-5-20251001');
    expect(drafter.maxTurns).toBe(6);

    // Shared reference injected via shared-references frontmatter list.
    expect(drafter.systemPrompt).toContain('## base-guidelines');
  });

  it('registers its output schema in the agent-schemas registry', () => {
    const schema = getAgentOutputSchema('reply-drafter');
    expect(schema).not.toBeNull();
    // Identity check — same module-scope Zod schema instance.
    expect(schema).toBe(replyDrafterOutputSchema);
  });

  it('every declared tool resolves in the central tool registry', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const drafter = agents.find((a) => a.name === 'reply-drafter');
    expect(drafter).toBeDefined();
    if (!drafter) return;

    // StructuredOutput is synthesized by runAgent at spawn time and isn't
    // in the central registry — every other tool must resolve.
    const missing = drafter.tools
      .filter((t) => t !== 'StructuredOutput')
      .filter((t) => toolRegistry.get(t) === undefined);
    expect(missing).toEqual([]);
  });
});
