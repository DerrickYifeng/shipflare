// Smoke test: community-scout AGENT.md + references load via the canonical
// loader path, the scout schema is registered, and the declared tools
// exist in the central registry (so Task-spawning the agent won't fail
// with an unresolved allowed-tools entry).

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';
import { getAgentOutputSchema } from '@/tools/AgentTool/agent-schemas';
import { registry as toolRegistry } from '@/tools/registry';
import { communityScoutOutputSchema } from '../schema';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

describe('community-scout loader smoke', () => {
  it('loads community-scout with frontmatter and references inlined', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const names = agents.map((a) => a.name);
    expect(names).toContain('community-scout');

    const scout = agents.find((a) => a.name === 'community-scout');
    expect(scout).toBeDefined();
    if (!scout) return;

    expect(scout.tools).toEqual(['run_discovery_scan', 'StructuredOutput']);
    expect(scout.model).toBe('claude-haiku-4-5-20251001');
    expect(scout.maxTurns).toBe(8);

    // Shared reference injected via shared-references frontmatter list.
    expect(scout.systemPrompt).toContain('## base-guidelines');
  });

  it('registers its output schema in the agent-schemas registry', () => {
    const schema = getAgentOutputSchema('community-scout');
    expect(schema).not.toBeNull();
    // Identity check — same module-scope Zod schema instance.
    expect(schema).toBe(communityScoutOutputSchema);
  });

  it('every declared tool resolves in the central tool registry', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const scout = agents.find((a) => a.name === 'community-scout');
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
