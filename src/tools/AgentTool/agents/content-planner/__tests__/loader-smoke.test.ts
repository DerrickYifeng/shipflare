// Smoke test: content-planner AGENT.md loads via the canonical loader
// path. Pins the model + tools allowlist so accidental regression on
// the planner is caught at CI. Phase G moved the allocation rules
// into the `allocating-plan-items` skill, so the agent now declares
// the `skill` tool and no longer inlines the tactical-playbook
// reference.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

describe('content-planner loader smoke', () => {
  it('loads with sonnet-4.6 model and the skill tool for allocation', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const planner = agents.find((a) => a.name === 'content-planner');
    expect(planner).toBeDefined();
    if (!planner) return;

    expect(planner.model).toBe('claude-sonnet-4-6');
    // Phase J Task 2 dropped `Task` from the allowlist — drafting is
    // batched downstream by the plan-execute-sweeper, so the planner
    // no longer fans out to writers.
    expect(planner.tools).toEqual([
      'add_plan_item',
      'update_plan_item',
      'query_recent_milestones',
      'query_stalled_items',
      'query_last_week_completions',
      'query_strategic_path',
      'query_recent_x_posts',
      'skill',
      'SendMessage',
      'StructuredOutput',
    ]);

    // Allocation rules moved to the allocating-plan-items skill.
    expect(planner.systemPrompt).not.toContain('## tactical-playbook');
    expect(planner.systemPrompt).toContain('allocating-plan-items');
  });
});
