// Ported from engine/tools/AgentTool/prompt.ts (Claude Code).
// buildTaskDescription composes the static teaching (delegation-teaching.md) with
// the dynamic agent list (formatAgentLine) at request time so every delegator
// sees both the rules and the current roster.
//
// Substitutions applied vs. CC:
//   - AGENT_TOOL_NAME -> 'Task' (our constant)
//   - FILE_READ_TOOL_NAME / GLOB_TOOL_NAME / BASH_TOOL_NAME references
//     are absent from delegation-teaching.md (already domain-substituted during
//     Phase A Day 1).
//   - Dropped: fork-subagent gating, coordinator-mode branching, KAIROS flag,
//     MCP-attachment-emit path, teammate / run_in_background hints.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentDefinition } from './loader';

/** Flat tool name matching the CC convention (`Task`). */
export const TASK_TOOL_NAME = 'Task';

/**
 * One-paragraph intro that opens the Task tool description. Ported from
 * engine/tools/AgentTool/prompt.ts:202-205.
 */
const BASE_DESCRIPTION =
  `Launch a new agent to handle complex, multi-step tasks autonomously.\n\n` +
  `The ${TASK_TOOL_NAME} tool launches a specialized subagent that owns the work ` +
  `end-to-end — picks its own tools, plans its steps, and returns a final result. ` +
  `Use it when a goal is best handled by a specialist (see the agent list below) ` +
  `rather than by you calling tools directly.`;

/**
 * Bullet list describing Task's input parameters. Ported from CC
 * `prompt.ts:255-274`, pruned to the three fields our schema accepts.
 */
const USAGE_NOTES =
  `## Using the ${TASK_TOOL_NAME} tool\n\n` +
  `Input parameters:\n` +
  `- \`subagent_type\` (required): the agent type to launch — must match one of the ` +
  `names in the available-specialists list above.\n` +
  `- \`prompt\` (required): the full briefing for the subagent. Write it like a ` +
  `director briefing a department head (see "Writing the Task prompt" below).\n` +
  `- \`description\` (required, <=100 chars): a short human-readable label for this ` +
  `delegation — shown in activity logs and the /team UI so founders can see what ` +
  `each subagent is working on.\n` +
  `- \`name\` (optional): a nickname for this particular subagent run. Useful when ` +
  `you launch multiple copies of the same \`subagent_type\` in parallel and want to ` +
  `refer to them distinctly in later messages.`;

// ---------------------------------------------------------------------------
// Delegation-teaching loader
// ---------------------------------------------------------------------------
//
// We read delegation-teaching.md synchronously at module-init time so
// buildTaskDescription() can stay synchronous (matching CC's prompt.ts).
// The file is a small piece of teaching text — bundled with the code — so a
// blocking read at import is fine. If the file is missing we fail loudly at
// startup rather than at first delegation.

const DELEGATION_TEACHING_PATH = resolve(
  __dirname,
  'references',
  'delegation-teaching.md',
);

let cachedDelegationTeaching: string | null = null;

function loadDelegationTeaching(): string {
  if (cachedDelegationTeaching !== null) return cachedDelegationTeaching;
  try {
    cachedDelegationTeaching = readFileSync(DELEGATION_TEACHING_PATH, 'utf8');
  } catch (err) {
    throw new Error(
      `buildTaskDescription: unable to read delegation-teaching.md at ` +
        `${DELEGATION_TEACHING_PATH}. Phase A Day 1 port must land before the ` +
        `Task tool description can be built. Underlying error: ${
          (err as Error).message
        }`,
    );
  }
  return cachedDelegationTeaching;
}

/** Test hook: clear the module-level cache between runs. */
export function __resetDelegationTeachingCache(): void {
  cachedDelegationTeaching = null;
}

// ---------------------------------------------------------------------------
// Per-agent formatting
// ---------------------------------------------------------------------------

/**
 * Format one agent line the delegator sees in the tool description:
 *   `- <name>: <description> (Tools: <toolList>)`.
 * Mirrors engine/tools/AgentTool/prompt.ts formatAgentLine().
 *
 * An agent with no `tools` array (shouldn't happen in practice because the
 * loader defaults to `[]`) renders as "Tools: none" — we surface that rather
 * than hide it, because a specialist with no tools is almost certainly a
 * misconfiguration the delegator should avoid selecting.
 */
export function formatAgentLine(agent: AgentDefinition): string {
  const toolList = agent.tools.length > 0 ? agent.tools.join(', ') : 'none';
  return `- ${agent.name}: ${agent.description} (Tools: ${toolList})`;
}

// ---------------------------------------------------------------------------
// buildTaskDescription
// ---------------------------------------------------------------------------

/**
 * Build the Task tool's `description` field shown to the delegating agent.
 *
 * Layout (spec §7 Layer 1):
 *   BASE_DESCRIPTION
 *   Available specialists and the tools they have access to:
 *   <one formatAgentLine per agent>
 *   USAGE_NOTES
 *   WHEN_NOT_TO_USE + WRITING_THE_PROMPT + LAUNCHING_IN_PARALLEL (all 3
 *   sections live in delegation-teaching.md; we embed the file verbatim
 *   after USAGE_NOTES so the teaching block arrives as one cohesive unit).
 *
 * Empty agent list is allowed — in that case the delegator has only direct-
 * handling tools and the teaching still reads cleanly ("no specialists
 * available"). Useful for tests and for coordinator-less configurations.
 */
export function buildTaskDescription(
  availableAgents: AgentDefinition[],
): string {
  const teaching = loadDelegationTeaching();

  const roster =
    availableAgents.length === 0
      ? 'No specialist agents are currently available — handle the request directly.'
      : `Available specialists and the tools they have access to:\n${availableAgents
          .map(formatAgentLine)
          .join('\n')}`;

  return `${BASE_DESCRIPTION}

${roster}

${USAGE_NOTES}

${teaching.trim()}
`;
}
