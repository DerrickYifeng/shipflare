// Smoke test: discovery-scout AGENT.md + references load via the canonical
// loader path, the scout schema is registered, and the declared tools
// exist in the central registry (so Task-spawning the agent won't fail
// with an unresolved allowed-tools entry).

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';
import { getAgentOutputSchema } from '@/tools/AgentTool/agent-schemas';
import { registry as toolRegistry } from '@/tools/registry';
import { discoveryScoutOutputSchema } from '../schema';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

describe('discovery-scout loader smoke', () => {
  it('loads discovery-scout with frontmatter and references inlined', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = agents.map((a) => a.name);
    expect(names).toContain('discovery-scout');

    const scout = agents.find((a) => a.name === 'discovery-scout');
    expect(scout).toBeDefined();
    if (!scout) return;

    expect(scout.tools).toEqual([
      'x_search_batch',
      'reddit_search',
      'StructuredOutput',
    ]);
    expect(scout.model).toBe('claude-haiku-4-5-20251001');
    expect(scout.maxTurns).toBe(10);

    // Per-agent reference inlined under the loader's "## <name>" header.
    expect(scout.systemPrompt).toContain('## judgment-rubric');
    expect(scout.systemPrompt).toContain('Cold-start bias');

    // Shared reference injected via shared-references frontmatter list.
    expect(scout.systemPrompt).toContain('## base-guidelines');
  });

  it('registers its output schema in the agent-schemas registry', () => {
    const schema = getAgentOutputSchema('discovery-scout');
    expect(schema).not.toBeNull();
    // Identity check — same module-scope Zod schema instance.
    expect(schema).toBe(discoveryScoutOutputSchema);
  });

  it('every declared tool resolves in the central tool registry', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const scout = agents.find((a) => a.name === 'discovery-scout');
    expect(scout).toBeDefined();
    if (!scout) return;

    // StructuredOutput is synthesized by runAgent at spawn time and isn't
    // in the central registry — every other tool must resolve.
    const missing = scout.tools
      .filter((t) => t !== 'StructuredOutput')
      .filter((t) => toolRegistry.get(t) === undefined);
    expect(missing).toEqual([]);
  });
});
