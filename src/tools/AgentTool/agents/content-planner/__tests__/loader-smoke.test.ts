// Smoke test: content-planner AGENT.md loads via the canonical loader
// path with its tactical-playbook reference inlined. Pins the model
// and the tools allowlist so accidental regression on the planner
// upgrade is caught at CI.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadAgentsDir } from '@/tools/AgentTool/loader';

const AGENTS_ROOT = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents',
);

describe('content-planner loader smoke', () => {
  it('loads with sonnet-4.6 model and the new query_recent_x_posts tool', async () => {
    const agents = await loadAgentsDir(AGENTS_ROOT);
    const planner = agents.find((a) => a.name === 'content-planner');
    expect(planner).toBeDefined();
    if (!planner) return;

    expect(planner.model).toBe('claude-sonnet-4-6');
    expect(planner.tools).toEqual([
      'add_plan_item',
      'update_plan_item',
      'query_recent_milestones',
      'query_stalled_items',
      'query_last_week_completions',
      'query_strategic_path',
      'query_recent_x_posts',
      'Task',
      'SendMessage',
      'StructuredOutput',
    ]);

    expect(planner.systemPrompt).toContain('## tactical-playbook');
  });
});
