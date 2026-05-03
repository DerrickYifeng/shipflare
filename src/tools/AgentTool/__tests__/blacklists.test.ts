import { describe, it, expect } from 'vitest';
import {
  INTERNAL_TEAMMATE_TOOLS,
  INTERNAL_SUBAGENT_TOOLS,
  getRoleBlacklist,
} from '@/tools/AgentTool/blacklists';
import { TASK_TOOL_NAME } from '@/tools/AgentTool/AgentTool';
import { SEND_MESSAGE_TOOL_NAME } from '@/tools/SendMessageTool/SendMessageTool';

describe('blacklists — Phase A', () => {
  it('forbids teammate from spawning sync subagents (Task)', () => {
    expect(INTERNAL_TEAMMATE_TOOLS.has(TASK_TOOL_NAME)).toBe(true);
  });

  it('subagent inherits teammate blacklist + cannot SendMessage', () => {
    for (const t of INTERNAL_TEAMMATE_TOOLS) {
      expect(INTERNAL_SUBAGENT_TOOLS.has(t)).toBe(true);
    }
    expect(INTERNAL_SUBAGENT_TOOLS.has(SEND_MESSAGE_TOOL_NAME)).toBe(true);
  });

  it('lead has empty blacklist (lead is the policy boundary, not the policed)', () => {
    const leadBL = getRoleBlacklist('lead');
    expect(leadBL.size).toBe(0);
  });
});
