// Ported skeleton from engine/tools/AgentTool/AgentTool.tsx call() (Claude Code, 1397 LOC).
// Stripped: ink/tmux UI, permission flow, worktree handling, remote CCR, feature flags
// (KAIROS, COORDINATOR_MODE, multi-agent gates), MCP init, proactive module,
// teammate spawn. Spawn depth limit (3) enforced here per spec §16.

import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolContext, ToolDefinition } from '@/core/types';
import { createLogger } from '@/lib/logger';
import { getAvailableAgents, resolveAgent } from './registry';
import {
  getContextDepth,
  spawnSubagent,
  type SpawnCallbacks,
} from './spawn';

const log = createLogger('tools:Task');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Flat snake-case identifier matching CC convention. */
export const TASK_TOOL_NAME = 'Task';

/**
 * Hard cap on spawn chain length. Prevents A→B→A style loops (spec §16,
 * Risk row "Circular Task calls"). The coordinator is depth 0; its direct
 * children are depth 1; allowed down to MAX_SPAWN_DEPTH.
 */
export const MAX_SPAWN_DEPTH = 3;

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------
//
// Per spec §5.4 we intentionally drop:
//   run_in_background, isolation, mode, team_name, cwd, model.

export const TaskInputSchema = z
  .object({
    subagent_type: z.string().min(1, 'subagent_type is required'),
    prompt: z.string().min(1, 'prompt is required'),
    description: z
      .string()
      .min(1, 'description is required')
      .max(100, 'description must be 100 characters or fewer'),
    name: z.string().optional(),
  })
  .strict();

export type TaskInput = z.infer<typeof TaskInputSchema>;

// ---------------------------------------------------------------------------
// Task result payload
// ---------------------------------------------------------------------------
//
// Shape matches the expectations declared in spec §9.3:
//   `{ result, cost, duration }` plus `turns` carried through from the
//   subagent's usage summary. Callers JSON-serialize this into tool_result
//   content — `result` is unknown because subagents without outputSchema
//   return `string`, agents with a schema return whatever their schema
//   resolves to. We let runAgent's generic bubble up.

export interface TaskResult {
  result: unknown;
  cost: number;
  /** Wall-clock duration in milliseconds. */
  duration: number;
  turns: number;
}

// ---------------------------------------------------------------------------
// Phase A Day 4 hook — deferred DB wiring
// ---------------------------------------------------------------------------
//
// The spec calls for a `team_tasks` row on every spawn. We don't create the
// table until Phase A Day 4, so this is a best-effort no-op for now.
// It is intentionally isolated so Day 4 can swap in a real implementation
// without touching the rest of this file.
//
// TODO(Phase A Day 4): INSERT into team_tasks, return the generated id so
// spawnSubagent can record it as parentTaskId on the child context.
async function recordTaskStart(
  _ctx: ToolContext,
  _input: TaskInput,
  _agentName: string,
): Promise<string | undefined> {
  return undefined;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * Task tool — spawns a subagent by AGENT.md `name`. Validates input, enforces
 * the spawn-depth limit, looks up the AgentDefinition, and delegates to
 * spawnSubagent(). Errors are caught and returned as structured strings so the
 * parent agent can read them via tool_result and self-correct.
 */
export const taskTool: ToolDefinition<TaskInput, TaskResult> = buildTool({
  name: TASK_TOOL_NAME,
  description:
    // Static fallback description — the real description injected into the
    // model's tool payload is built per-run by `buildTaskDescription()` in
    // prompt.ts, which has access to the live agent roster. This field is the
    // internal library-side description surfaced in logs and tests.
    'Launch a specialist subagent to handle a complex, multi-step task end-to-end. ' +
    'Prefer direct tool calls for simple reads; reserve Task for work that needs ' +
    'planning, multiple tool calls, or a specialist\'s domain knowledge.',
  inputSchema: TaskInputSchema,
  // Two Task calls in the same turn should run in parallel when possible —
  // that's how the coordinator fans out to multiple specialists. Each spawned
  // subagent has its own AbortController and runs independently.
  isConcurrencySafe: true,
  // Task is never side-effect-free: the subagent it spawns may write to DB.
  isReadOnly: false,
  async execute(input, ctx): Promise<TaskResult> {
    // Spec §16: cap the spawn chain length BEFORE doing any work. Reading
    // depth off the caller's ToolContext means this check sees the live
    // chain regardless of whether the caller went through the registry or
    // spawnSubagent directly.
    const currentDepth = getContextDepth(ctx);
    if (currentDepth >= MAX_SPAWN_DEPTH) {
      throw new Error(
        `Task: spawn depth limit reached (${currentDepth} >= ${MAX_SPAWN_DEPTH}). ` +
          `Refusing to spawn "${input.subagent_type}" to prevent circular delegation. ` +
          `Restructure the work so the specialist returns results to an earlier link in the chain ` +
          `instead of spawning deeper.`,
      );
    }

    const agent = await resolveAgent(input.subagent_type);
    if (!agent) {
      const available = (await getAvailableAgents())
        .map((a) => a.name)
        .sort();
      throw new Error(
        `Task: unknown subagent_type "${input.subagent_type}". ` +
          `Valid types: ${
            available.length > 0 ? available.join(', ') : '(none registered)'
          }.`,
      );
    }

    const parentTaskId = await recordTaskStart(ctx, input, agent.name);

    log.debug(
      `Task spawning "${agent.name}" (depth=${currentDepth + 1}, desc="${input.description}")`,
    );

    const startedAt = Date.now();

    // Callbacks: Day 3 has no consumer for onMessage / onToolCall / onError
    // on the Task surface — the /team UI event stream is a Day 4 concern. We
    // intentionally leave them undefined so runAgent doesn't emit work it
    // doesn't need to.
    const callbacks: SpawnCallbacks | undefined = undefined;

    const agentResult = await spawnSubagent(
      agent,
      input.prompt,
      ctx,
      callbacks,
      undefined, // outputSchema: Task callers don't pre-declare one — subagents
      //            use their own StructuredOutput when they need structured
      //            returns (inferred from their tool list at runtime).
      parentTaskId,
    );

    const duration = Date.now() - startedAt;

    return {
      result: agentResult.result,
      cost: agentResult.usage.costUsd,
      duration,
      turns: agentResult.usage.turns,
    };
  },
});
