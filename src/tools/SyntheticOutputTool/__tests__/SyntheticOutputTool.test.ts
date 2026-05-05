import { describe, it, expect } from 'vitest';
import {
  syntheticOutputTool,
  SYNTHETIC_OUTPUT_TOOL_NAME,
} from '@/tools/SyntheticOutputTool/SyntheticOutputTool';

describe('SyntheticOutputTool', () => {
  it('exports the canonical tool name', () => {
    expect(SYNTHETIC_OUTPUT_TOOL_NAME).toBe('SyntheticOutput');
  });

  it('the tool name field matches the constant', () => {
    expect(syntheticOutputTool.name).toBe(SYNTHETIC_OUTPUT_TOOL_NAME);
  });

  it('isEnabled() returns false (architecture-level invariant)', () => {
    expect(syntheticOutputTool.isEnabled()).toBe(false);
  });

  it('is NOT registered in any role whitelist', async () => {
    // role-tools.ts exports individual constants (TEAM_LEAD_ALLOWED_TOOLS,
    // TEAMMATE_ALLOWED_TOOLS, SUBAGENT_ALLOWED_TOOLS) and a getRoleWhitelist
    // resolver. There is no `ROLE_WHITELISTS` aggregate today. The semantic
    // invariant we enforce: the SyntheticOutput name MUST NOT appear as a
    // literal entry in any whitelist set.
    //
    // Phase A whitelists currently only contain the `'*'` ALL_TOOLS sentinel —
    // that's an allow-all marker that the layer-③ blacklist filters out, so
    // `getRoleWhitelist('lead' | 'member').has(SYNTHETIC_OUTPUT_TOOL_NAME)`
    // reflects "is the name explicitly listed", which must always be false.
    const { getRoleWhitelist } = await import(
      '@/tools/AgentTool/role-tools'
    );
    expect(getRoleWhitelist('lead').has(SYNTHETIC_OUTPUT_TOOL_NAME)).toBe(
      false,
    );
    expect(getRoleWhitelist('member').has(SYNTHETIC_OUTPUT_TOOL_NAME)).toBe(
      false,
    );
    expect(getRoleWhitelist('subagent').has(SYNTHETIC_OUTPUT_TOOL_NAME)).toBe(
      false,
    );
  });

  it('IS in INTERNAL_TEAMMATE_TOOLS (Phase B addition)', async () => {
    const { INTERNAL_TEAMMATE_TOOLS } = await import(
      '@/tools/AgentTool/blacklists'
    );
    expect(INTERNAL_TEAMMATE_TOOLS.has(SYNTHETIC_OUTPUT_TOOL_NAME)).toBe(true);
  });
});
