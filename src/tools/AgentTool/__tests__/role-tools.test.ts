import { describe, it, expect } from 'vitest';
import {
  getRoleWhitelist,
  TEAM_LEAD_ALLOWED_TOOLS,
  TEAMMATE_ALLOWED_TOOLS,
  SUBAGENT_ALLOWED_TOOLS,
  type AgentRole,
} from '@/tools/AgentTool/role-tools';

describe('role-tools — Phase A whitelists', () => {
  it('exposes a Set per role', () => {
    expect(TEAM_LEAD_ALLOWED_TOOLS).toBeInstanceOf(Set);
    expect(TEAMMATE_ALLOWED_TOOLS).toBeInstanceOf(Set);
    expect(SUBAGENT_ALLOWED_TOOLS).toBeInstanceOf(Set);
  });

  it('Phase A: all whitelists are "any registered tool" (use blacklist to subtract)', () => {
    // Phase A keeps the whitelists permissive — narrowing happens in
    // Phase B/C/D when SendMessage / Sleep / TaskStop add per-role
    // distinctions. The blacklist is the only narrowing source today.
    expect(TEAM_LEAD_ALLOWED_TOOLS.has('*')).toBe(true);
    expect(TEAMMATE_ALLOWED_TOOLS.has('*')).toBe(true);
    expect(SUBAGENT_ALLOWED_TOOLS.has('*')).toBe(true);
  });

  it('getRoleWhitelist resolves by role', () => {
    const lead: AgentRole = 'lead';
    const member: AgentRole = 'member';
    expect(getRoleWhitelist(lead)).toBe(TEAM_LEAD_ALLOWED_TOOLS);
    expect(getRoleWhitelist(member)).toBe(TEAMMATE_ALLOWED_TOOLS);
  });

  it('getRoleWhitelist resolves the subagent role (used by assembleToolPool in Task 10)', () => {
    // Subagents are not loaded from AGENT.md (no `role` frontmatter), so
    // 'subagent' is not part of `AgentRole`. It IS, however, a valid input
    // to `assembleToolPool` (Task 10) when the Task tool dispatches a
    // sync subagent with the parent's filtered context. The whitelist
    // resolver therefore accepts it explicitly.
    expect(getRoleWhitelist('subagent')).toBe(SUBAGENT_ALLOWED_TOOLS);
  });
});
