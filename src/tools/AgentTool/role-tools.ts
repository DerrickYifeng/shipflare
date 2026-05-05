// Per-role tool WHITELISTS — layer ② of the four-layer filter pipeline
// (engine PDF §3.5.1). Used by `assembleToolPool` (Task 10).
//
// Phase A: all roles permit '*' (any registered tool). Narrowing happens
// today via layer ③ (blacklists, Task 8) and layer ④ (AgentDefinition.tools
// allow-list + disallowedTools subtract). Phase B/C/D introduce role-specific
// narrowing as new tools (TaskStop, Sleep, SendMessage) come online and need
// per-role gating.

import type { AgentRole } from './loader';

/** Sentinel meaning "any registered tool name passes layer ②". */
export const ALL_TOOLS = '*' as const;

export const TEAM_LEAD_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ALL_TOOLS,
]);

export const TEAMMATE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ALL_TOOLS,
]);

export const SUBAGENT_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ALL_TOOLS,
]);

/**
 * Resolves the layer-② whitelist for a given execution role.
 *
 * Note on the role widening: `AgentRole` (defined in `loader.ts`) is
 * `'lead' | 'member'` because it reflects the values legal in AGENT.md
 * frontmatter. Subagents, however, have no AgentDefinition — they are
 * dispatched at runtime by the Task tool with the parent's filtered
 * context. Task 10's `assembleToolPool` accepts `'subagent'` as a third
 * role for that path, so we explicitly widen the parameter type here.
 */
export function getRoleWhitelist(
  role: AgentRole | 'subagent',
): ReadonlySet<string> {
  switch (role) {
    case 'lead':
      return TEAM_LEAD_ALLOWED_TOOLS;
    case 'member':
      return TEAMMATE_ALLOWED_TOOLS;
    case 'subagent':
      return SUBAGENT_ALLOWED_TOOLS;
  }
}

export type { AgentRole };
