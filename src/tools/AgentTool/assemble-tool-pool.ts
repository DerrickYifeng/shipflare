// Single source of truth for "what tools does agent X see?".
//
// Engine PDF §3.5.1: the user-context injection text shown to the
// team-lead's LLM ("teammates have access to these tools: …") and the
// runtime tool list given to a teammate's runAgent both flow through
// this function. By construction they cannot drift.
//
// Four layers (in order):
//   ① getAll() on the ToolRegistry
//   ② role whitelist  (role-tools.ts)            — '*' = pass
//   ③ role blacklist  (blacklists.ts)            — set membership
//   ④ AgentDefinition.tools allow-list           — '*' = pass
//      AgentDefinition.disallowedTools subtract

import type { AnyToolDefinition } from '@/core/types';
import type { ToolRegistry } from '@/core/tool-system';
import type { AgentDefinition, AgentRole } from './loader';
import { getRoleWhitelist, ALL_TOOLS } from './role-tools';
import { getRoleBlacklist, INTERNAL_SUBAGENT_TOOLS } from './blacklists';

function passesWhitelist(
  toolName: string,
  role: AgentRole | 'subagent',
): boolean {
  const wl = getRoleWhitelist(role);
  // ALL_TOOLS sentinel must short-circuit BEFORE literal name membership;
  // otherwise a whitelist containing only `'*'` would reject every name.
  return wl.has(ALL_TOOLS) || wl.has(toolName);
}

function passesBlacklist(
  toolName: string,
  role: AgentRole | 'subagent',
): boolean {
  // Subagents use INTERNAL_SUBAGENT_TOOLS directly; getRoleBlacklist
  // only covers AgentRole (lead/member). This asymmetry is documented
  // in blacklists.ts and role-tools.ts.
  if (role === 'subagent') {
    return !INTERNAL_SUBAGENT_TOOLS.has(toolName);
  }
  return !getRoleBlacklist(role).has(toolName);
}

function passesAgentAllow(
  toolName: string,
  agentTools: readonly string[] | '*',
): boolean {
  if (agentTools === '*') return true;
  // Allow `tools: ['*']` array-form sentinel for AGENT.md ergonomics.
  if (
    Array.isArray(agentTools) &&
    agentTools.length === 1 &&
    agentTools[0] === '*'
  ) {
    return true;
  }
  return (agentTools as readonly string[]).includes(toolName);
}

function passesAgentDisallow(
  toolName: string,
  disallowed: readonly string[],
): boolean {
  return !disallowed.includes(toolName);
}

/**
 * Compute the tool pool that agent `def` should see when running with
 * role `role` against registry `registry`. Pure function — no side
 * effects, deterministic.
 */
export function assembleToolPool(
  role: AgentRole | 'subagent',
  def: AgentDefinition,
  registry: ToolRegistry,
): AnyToolDefinition[] {
  const all = registry.getAll();
  return all.filter((tool) => {
    return (
      passesWhitelist(tool.name, role) &&
      passesBlacklist(tool.name, role) &&
      passesAgentAllow(tool.name, def.tools) &&
      passesAgentDisallow(tool.name, def.disallowedTools)
    );
  });
}

/**
 * Tool names — for use in the team-lead's user-context injection text
 * (engine `getCoordinatorUserContext` L80-93 equivalent). Always sorted
 * for stable prompt-cache hits.
 */
export function getInjectionTextNames(
  role: AgentRole | 'subagent',
  def: AgentDefinition,
  registry: ToolRegistry,
): string[] {
  return assembleToolPool(role, def, registry)
    .map((t) => t.name)
    .sort();
}
