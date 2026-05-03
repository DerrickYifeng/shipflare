import { describe, it, expect } from 'vitest';
import {
  INTERNAL_TEAMMATE_TOOLS,
  INTERNAL_SUBAGENT_TOOLS,
  getRoleBlacklist,
} from '@/tools/AgentTool/blacklists';
import { TASK_TOOL_NAME } from '@/tools/AgentTool/AgentTool';
import { SEND_MESSAGE_TOOL_NAME } from '@/tools/SendMessageTool/SendMessageTool';
import { SLEEP_TOOL_NAME } from '@/tools/SleepTool/SleepTool';

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

  it('subagent additionally cannot Sleep (must complete in-turn — Phase D)', () => {
    // Subagents are awaited by their parent; yielding mid-turn would orphan
    // the parent's await on <task-notification>. Lead + member CAN Sleep.
    expect(INTERNAL_SUBAGENT_TOOLS.has(SLEEP_TOOL_NAME)).toBe(true);
    expect(INTERNAL_TEAMMATE_TOOLS.has(SLEEP_TOOL_NAME)).toBe(false);
    expect(getRoleBlacklist('lead').has(SLEEP_TOOL_NAME)).toBe(false);
    expect(getRoleBlacklist('member').has(SLEEP_TOOL_NAME)).toBe(false);
  });
});
