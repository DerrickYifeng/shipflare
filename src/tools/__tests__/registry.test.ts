import { describe, it, expect } from 'vitest';
import { registry } from '@/tools/registry';
// Side-effect import: registry-team.ts wires the deferred-registration tools
// (Task, SendMessage, Skill) into the central registry. They're split out of
// registry.ts to avoid the module cycle through AgentTool/spawn.ts.
import '@/tools/registry-team';
import { SKILL_TOOL_NAME } from '@/tools/SkillTool/constants';

describe('central tool registry', () => {
  it('has SkillTool registered under the canonical name', () => {
    const tool = registry.get(SKILL_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool?.name).toBe(SKILL_TOOL_NAME);
  });
});
