// Per-role tool BLACKLISTS — layer ③ of the four-layer filter pipeline
// (engine PDF §3.5.1). Used by `assembleToolPool`.
//
// These enforce ARCHITECTURE-LEVEL invariants — not domain limits.
// Removing TASK_TOOL_NAME from INTERNAL_TEAMMATE_TOOLS, for instance,
// allows teammates to spawn sub-subagents, breaking the "single
// coordinator" invariant. Such removals are review-rejects.
//
// Phase A scope: only tools that exist today are present. Reserved
// future blacklist entries (TaskStop, TeamCreate, TeamDelete) are added
// in their respective Phase B/C/D landings. Phase B added SyntheticOutput
// (architecture invariant: only the system, never an agent, may synthesize
// a <task-notification>). Phase C added TaskStop (lead-only; teammates
// cannot stop peers — engine PDF §2.4).

import { TASK_TOOL_NAME } from './AgentTool';
import { SEND_MESSAGE_TOOL_NAME } from '@/tools/SendMessageTool/SendMessageTool';
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '@/tools/SyntheticOutputTool/SyntheticOutputTool';
import { TASK_STOP_TOOL_NAME } from '@/tools/TaskStopTool/TaskStopTool';
import type { AgentRole } from './loader';

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Tools no `member` may use — protects "single-direction, tree-shaped
 * coordination" (engine PDF §3.5.2).
 *
 * Phase A members: { Task }.
 * Phase B adds: { SyntheticOutput } (architecture invariant: only the
 *   system, never an agent, may synthesize a <task-notification>).
 * Phase C adds: { TaskStop } (lead-only graceful-stop lever; teammates
 *   cannot stop peers — engine PDF §2.4).
 * Phase D+ adds: TeamCreate, TeamDelete.
 */
export const INTERNAL_TEAMMATE_TOOLS: ReadonlySet<string> = new Set([
  TASK_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
]);

/**
 * Sync subagents (mode-2) inherit the teammate blacklist and additionally
 * lose `SendMessage` — they must complete in their turn without
 * initiating further coordination.
 *
 * Phase A subagents: teammate blacklist + { SendMessage }.
 * Phase D adds: Sleep (subagents cannot yield mid-turn).
 */
export const INTERNAL_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  ...INTERNAL_TEAMMATE_TOOLS,
  SEND_MESSAGE_TOOL_NAME,
]);

export function getRoleBlacklist(role: AgentRole): ReadonlySet<string> {
  switch (role) {
    case 'lead':
      return EMPTY_SET;
    case 'member':
      return INTERNAL_TEAMMATE_TOOLS;
  }
}
