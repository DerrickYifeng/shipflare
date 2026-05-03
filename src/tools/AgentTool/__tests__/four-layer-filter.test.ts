import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
// Side-effect import: registry-team.ts wires the deferred-registration tools
// (Task, SendMessage, Skill) into the central registry. Without this import,
// the valid-agent fixture's [Task, query_plan_items, SendMessage] declarations
// would resolve to "unknown tool" errors at the diagnostic wrapper around
// assembleToolPool.
import '@/tools/registry-team';
import { loadAgent } from '@/tools/AgentTool/loader';
import { resolveAgentTools } from '@/tools/AgentTool/spawn';

const FIXTURES = path.resolve(__dirname, 'fixtures');
const SHARED_REFS = path.join(FIXTURES, '_shared', 'references');

describe('four-layer filter — spawn.resolveAgentTools delegates to assembleToolPool', () => {
  it('member with tools=[Task,SendMessage,query_plan_items] → blacklists Task', async () => {
    // The valid-agent fixture declares tools: [Task, query_plan_items, SendMessage].
    // It has no role (defaults to 'member'). After Task 11, spawn.resolveAgentTools
    // must filter out 'Task' (architecture-level invariant via INTERNAL_TEAMMATE_TOOLS).
    const agent = await loadAgent(path.join(FIXTURES, 'valid-agent'), {
      sharedReferencesDir: SHARED_REFS,
    });
    expect(agent.role).toBe('member');
    const resolved = resolveAgentTools(agent);
    const names = resolved.map((t) => t.name).sort();
    // 'Task' must be gone after the refactor.
    expect(names).not.toContain('Task');
    // The other declared tools pass through (assuming they're registered;
    // SendMessage is a real registered tool).
    expect(names).toContain('SendMessage');
  });

  it('lead with tools=[Task,SendMessage] → both kept (lead unblacklisted)', async () => {
    // Until Task 12 tags coordinator as role: lead in AGENT.md, we synthesize
    // a lead-tagged def in the test by overriding the role field.
    const agent = await loadAgent(path.join(FIXTURES, 'valid-agent'), {
      sharedReferencesDir: SHARED_REFS,
    });
    const leadDef = { ...agent, role: 'lead' as const };
    const resolved = resolveAgentTools(leadDef);
    const names = resolved.map((t) => t.name).sort();
    expect(names).toContain('SendMessage');
    expect(names).toContain('Task');
  });

  it('coordinator (role=lead) keeps Task; content-manager (role=member) has no Task', async () => {
    const root = path.resolve(__dirname, '../agents');
    const lead = await loadAgent(path.join(root, 'coordinator'));
    const member = await loadAgent(path.join(root, 'content-manager'));
    expect(lead.role).toBe('lead');
    expect(member.role).toBe('member');
    expect(resolveAgentTools(lead).map((t) => t.name)).toContain('Task');
    expect(resolveAgentTools(member).map((t) => t.name)).not.toContain('Task');
  });
});
