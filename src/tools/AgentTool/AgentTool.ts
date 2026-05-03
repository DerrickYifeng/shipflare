// Ported skeleton from engine/tools/AgentTool/AgentTool.tsx call() (Claude Code, 1397 LOC).
// Stripped: ink/tmux UI, permission flow, worktree handling, remote CCR, feature flags
// (KAIROS, COORDINATOR_MODE, multi-agent gates), MCP init, proactive module,
// teammate spawn. Spawn depth limit (3) enforced here per spec §16.

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type {
  StreamEvent,
  StreamEventSpawnMeta,
  ToolContext,
  ToolDefinition,
} from '@/core/types';
import { createLogger } from '@/lib/logger';
import type { Database } from '@/lib/db';
import { agentRuns, teamMembers, teamMessages, teamTasks } from '@/lib/db/schema';
import { getAvailableAgents, resolveAgent } from './registry';
import { getAgentOutputSchema } from './agent-schemas';
import {
  getContextDepth,
  spawnSubagent,
  type SpawnCallbacks,
} from './spawn';
import { teamHasBudgetRemaining } from '@/lib/team-budget';
import { wake } from '@/workers/processors/lib/wake';

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
//   isolation, mode, team_name, cwd, model.
// Phase B re-adds `run_in_background` as an opt-in async path; the option
// only takes effect when the call carries a team-run context (`teamId`,
// `currentMemberId`, `db`). Otherwise it's silently ignored and the call
// falls through to the existing sync spawn path. (Phase G removed the
// `SHIPFLARE_AGENT_TEAMS` feature flag — Agent Teams is now the default.)

export const TaskInputSchema = z
  .object({
    subagent_type: z.string().min(1, 'subagent_type is required'),
    prompt: z.string().min(1, 'prompt is required'),
    description: z
      .string()
      .min(1, 'description is required')
      .max(100, 'description must be 100 characters or fewer'),
    name: z.string().optional(),
    /**
     * Phase B: opt-in async path. When true AND a team-run context is
     * present, the call returns immediately with
     * `{agentId, status:'async_launched'}`; otherwise it falls through to
     * the synchronous spawn path. (Phase G removed the
     * `SHIPFLARE_AGENT_TEAMS` feature flag — async path now fires
     * unconditionally when both preconditions are met.)
     */
    run_in_background: z.boolean().optional(),
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
  /**
   * Set on the Phase B async return — the `agent_runs.id` of the spawned
   * teammate. Undefined for the synchronous path.
   */
  agentId?: string;
  /**
   * Lifecycle marker. `'completed'` for the sync path (the spawned subagent
   * has already produced `result`); `'async_launched'` for the Phase B
   * opt-in async path (the agent_runs row is in `'queued'` state and the
   * BullMQ wake has been enqueued — no result yet).
   */
  status?: 'completed' | 'async_launched';
}

// ---------------------------------------------------------------------------
// team_tasks persistence (Phase A Day 4)
// ---------------------------------------------------------------------------

/**
 * Pull optional deps off the ToolContext. When this Task invocation is part
 * of a team run, all four keys are present; when it's invoked from an
 * ad-hoc caller (tests, CLI), some are absent and we degrade gracefully.
 */
function readUserIdFromCtx(ctx: ToolContext): string | null {
  try {
    const v = ctx.get<string | null>('userId');
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Read the agent_runs.id of the agent currently executing this Task call.
 * The agent-run processor (Phase D Task 4) injects `callerAgentId` into the
 * ToolContext for every tool invocation. When the lead spawns a teammate
 * via `Task(run_in_background:true)`, this returns the lead's agentId, which
 * becomes the spawned teammate's `parentAgentId` — the routing key the
 * teammate's eventual `task_notification` uses to find its parent's mailbox.
 *
 * Returns null when the ctx isn't agent-scoped (legacy callers, tests,
 * CLI). The async branch tolerates a null parent — agent_runs.parent_agent_id
 * is nullable.
 */
function getCallerAgentId(ctx: ToolContext): string | null {
  try {
    const v = ctx.get<string>('callerAgentId');
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function readTeamDeps(ctx: ToolContext): {
  db: Database | null;
  runId: string | null;
  teamId: string | null;
  currentMemberId: string | null;
  parentTaskId: string | null;
} {
  function tryGet<T>(key: string): T | null {
    try {
      return ctx.get<T>(key);
    } catch {
      return null;
    }
  }
  const extended = ctx as unknown as { parentTaskId?: string };
  return {
    db: tryGet<Database>('db'),
    runId: tryGet<string>('runId'),
    teamId: tryGet<string>('teamId'),
    currentMemberId: tryGet<string>('currentMemberId'),
    parentTaskId: extended.parentTaskId ?? null,
  };
}

/**
 * INSERT team_tasks with status='running'. Returns the generated task id
 * (opaque to the caller — passed back into spawnSubagent so nested spawns
 * can chain through `parent_task_id`).
 */
async function recordTaskStart(
  ctx: ToolContext,
  input: TaskInput,
  agentName: string,
): Promise<string | undefined> {
  const { db, runId, teamId, currentMemberId, parentTaskId } = readTeamDeps(ctx);
  if (!db || !runId || !teamId || !currentMemberId) {
    // Not a team run — skip the insert.
    return undefined;
  }
  // Read the tool_use_id for *this* Task invocation (tool-executor
  // plumbs it in via a per-call ctx proxy). Stashing it in
  // `input.toolUseId` lets the UI's `taskLookup` join tool_call rows to
  // team_tasks without a schema migration — the reducer extracts
  // `toolUseId` from the coordinator's tool_call metadata, and
  // page.tsx builds a dual-key map so either side hits.
  let toolUseId: string | null = null;
  try {
    const fromCtx = ctx.get<string | null | undefined>('toolUseId');
    if (typeof fromCtx === 'string' && fromCtx.length > 0) toolUseId = fromCtx;
  } catch {
    // ctx.get throws on unknown keys in some ctx implementations —
    // treat as "not a team run context with toolUseId" and move on.
    toolUseId = null;
  }
  const taskId = crypto.randomUUID();
  await db.insert(teamTasks).values({
    id: taskId,
    runId,
    parentTaskId,
    // member_id is the member that is ABOUT TO EXECUTE the task — i.e. the
    // spawn target, not the caller. We don't have a team_members row for
    // the subagent directly in Phase A (the team provisioner's Phase F
    // responsibility), so we record the CALLER as member_id for now.
    // TODO(Phase F): resolve team_members row for `agent_type=agentName`
    // and record that id here instead.
    memberId: currentMemberId,
    description: input.description,
    prompt: input.prompt,
    input: {
      subagent_type: input.subagent_type,
      description: input.description,
      prompt: input.prompt,
      ...(input.name !== undefined ? { name: input.name } : {}),
      agentName,
      ...(toolUseId !== null ? { toolUseId } : {}),
    },
    status: 'running',
    startedAt: new Date(),
    turns: 0,
  });
  return taskId;
}

async function recordTaskComplete(
  ctx: ToolContext,
  taskId: string,
  output: unknown,
  costUsd: number,
  turns: number,
): Promise<void> {
  const { db } = readTeamDeps(ctx);
  if (!db) return;
  await db
    .update(teamTasks)
    .set({
      status: 'completed',
      completedAt: new Date(),
      costUsd: String(costUsd),
      turns,
      output: output as Record<string, unknown>,
    })
    .where(eq(teamTasks.id, taskId));
}

async function recordTaskFailure(
  ctx: ToolContext,
  taskId: string,
  message: string,
): Promise<void> {
  const { db } = readTeamDeps(ctx);
  if (!db) return;
  await db
    .update(teamTasks)
    .set({
      status: 'failed',
      completedAt: new Date(),
      errorMessage: message,
    })
    .where(eq(teamTasks.id, taskId));
}

/**
 * Best-effort resolve the spawned specialist's `team_members.id` so events
 * emitted inside its runAgent can be attributed to it in the activity log.
 * Returns `null` when ctx isn't team-scoped (tests / CLI) or when the
 * team_provisioner hasn't seeded a row for this agent_type yet — callers
 * fall back to the caller's memberId for legacy-compatible attribution.
 */
async function resolveSpecialistMemberId(
  ctx: ToolContext,
  agentType: string,
): Promise<string | null> {
  const { db, teamId } = readTeamDeps(ctx);
  if (!db || !teamId) return null;
  try {
    const rows = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(eq(teamMembers.teamId, teamId), eq(teamMembers.agentType, agentType)),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Wrap a parent's onEvent so that `tool_start` / `tool_done` events emitted
 * inside the child's runAgent carry a `spawnMeta` tag pointing at the
 * `team_tasks.id` row the child is running under. The innermost spawn tags
 * the event; deeper spawns preserve an existing tag so leaf events always
 * carry their immediate parent. Non-tool events pass through untouched.
 */
function wrapOnEventWithSpawnMeta(
  parentOnEvent: (event: StreamEvent) => void | Promise<void>,
  spawnMeta: StreamEventSpawnMeta,
): (event: StreamEvent) => void | Promise<void> {
  return (event) => {
    if (event.type === 'tool_start' || event.type === 'tool_done') {
      if (event.spawnMeta !== undefined) {
        return parentOnEvent(event);
      }
      return parentOnEvent({ ...event, spawnMeta });
    }
    // Assistant-text streaming events also need the spawnMeta tag so
    // the worker can stamp `parentToolUseId` on the published agent_text
    // row — without it, subagent text would render attributed to the
    // coordinator's thread instead of nested inside the subtask card.
    if (
      event.type === 'assistant_text_start' ||
      event.type === 'assistant_text_delta' ||
      event.type === 'assistant_text_stop'
    ) {
      if (event.spawnMeta !== undefined) {
        return parentOnEvent(event);
      }
      return parentOnEvent({ ...event, spawnMeta });
    }
    // Tool-input streaming (per-JSON-delta) stays untagged for now —
    // the partial JSON lands client-side by tool_use_id alone, which
    // is already scoped to the subagent that's writing it.
    return parentOnEvent(event);
  };
}

// ---------------------------------------------------------------------------
// Phase B — async branch: launch a teammate by inserting `agent_runs` +
// initial mailbox message, then waking the agent-run BullMQ worker.
//
// This path returns IMMEDIATELY with `{agentId, status:'async_launched'}`.
// The lead's mailbox-drain loop (Phase B Task 12) is what eventually
// surfaces the teammate's `<task-notification>` back to the caller.
// ---------------------------------------------------------------------------

async function launchAsyncTeammate(
  input: TaskInput,
  ctx: ToolContext,
): Promise<TaskResult> {
  const { db, teamId, currentMemberId } = readTeamDeps(ctx);
  if (!db || !teamId || !currentMemberId) {
    // Caller upstream guarantees these are present (we only enter this
    // branch when readTeamDeps already produced a teamId), but the type
    // narrowing is local so we re-check defensively.
    throw new Error(
      'Task: async branch requires team-run context (db, teamId, currentMemberId)',
    );
  }

  const agent = await resolveAgent(input.subagent_type);
  if (!agent) {
    const available = (await getAvailableAgents()).map((a) => a.name).sort();
    throw new Error(
      `Task: unknown subagent_type "${input.subagent_type}". ` +
        `Valid types: ${
          available.length > 0 ? available.join(', ') : '(none registered)'
        }.`,
    );
  }

  const agentId = crypto.randomUUID();

  // Phase E Task 7: read the caller's agentId from the ctx the agent-run
  // processor (Phase D Task 4) injected. When the lead spawns a teammate,
  // callerAgentId === lead.agentId; sub-spawns (forbidden by
  // INTERNAL_TEAMMATE_TOOLS in Phase C) would carry the parent teammate's
  // id. Null when no agent-scoped ctx is present (legacy / test paths) —
  // agent_runs.parent_agent_id is nullable so this is safe.
  const parentAgentId = getCallerAgentId(ctx);

  // 1. Queue the agent_runs row. The agent-run worker (Task 9) drains its
  //    mailbox and drives runAgent against `agentDefName`.
  await db.insert(agentRuns).values({
    id: agentId,
    teamId,
    memberId: currentMemberId,
    agentDefName: input.subagent_type,
    parentAgentId,
    status: 'queued',
  });

  // 2. Initial prompt as the FIRST mailbox message addressed to the new
  //    agentId. The agent-run processor reads it via drainMailbox.
  await db.insert(teamMessages).values({
    teamId,
    type: 'user_prompt',
    messageType: 'message',
    fromMemberId: currentMemberId,
    toAgentId: agentId,
    content: input.prompt,
    summary: input.description,
  });

  // 3. Wake the agent-run worker via BullMQ. Idempotent within a 1-second
  //    bucket (see wake.ts).
  await wake(agentId);

  log.debug(
    `Task launched async teammate "${input.subagent_type}" agentId=${agentId} ` +
      `team=${teamId} parent_member=${currentMemberId}`,
  );

  return {
    result: null,
    cost: 0,
    duration: 0,
    turns: 0,
    agentId,
    status: 'async_launched',
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * Task tool — spawns a subagent by AGENT.md `name`. Validates input, enforces
 * the spawn-depth limit, looks up the AgentDefinition, and delegates to
 * spawnSubagent(). Errors are caught and returned as structured strings so the
 * parent agent can read them via tool_result and self-correct.
 *
 * Phase B: when `input.run_in_background === true` AND the team flag is on
 * AND a team-run context is present, the call returns immediately with
 * `{agentId, status:'async_launched'}` and the spawned teammate runs out
 * of band. Any failed precondition silently falls through to the existing
 * sync path so existing callers and tests are unaffected.
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
    // Phase B — async branch (opt-in via `run_in_background:true`).
    //
    // Fires ONLY when ALL of:
    //   1. `input.run_in_background === true`
    //   2. The call has a team-run context (`teamId` resolvable from ctx)
    //
    // Any failed precondition silently falls through to the sync path —
    // this preserves backward compatibility for ad-hoc / CLI / test
    // callers that don't carry team context. (Phase G removed the
    // `SHIPFLARE_AGENT_TEAMS` feature flag — Agent Teams is the default
    // and the async path is always taken when the two preconditions are
    // met.)
    if (input.run_in_background === true) {
      const { teamId: asyncTeamId } = readTeamDeps(ctx);
      if (asyncTeamId !== null) {
        return await launchAsyncTeammate(input, ctx);
      }
    }

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

    // Phase G Day 2: refuse to spawn once the team's weekly budget is
    // exhausted. Checked before resolve/record so budget-capped runs don't
    // leave partial team_tasks rows behind. Allow query_* / add_plan_item /
    // SendMessage to continue so the coordinator can still summarize.
    const { db: budgetDb, teamId: budgetTeamId } = readTeamDeps(ctx);
    if (budgetDb && budgetTeamId) {
      const hasBudget = await teamHasBudgetRemaining(budgetTeamId, budgetDb);
      if (!hasBudget) {
        throw new Error(
          `Task: team weekly budget reached. Budget resets Monday 00:00 UTC. ` +
            `Refusing to spawn "${input.subagent_type}". ` +
            `Summarize remaining work via text or SendMessage instead.`,
        );
      }
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

    // Forward the parent's onEvent (if provided via ToolContext) to the
    // child runAgent so the subagent's tool_start / tool_done events land
    // on the same team_messages channel as the parent's. The team-run
    // worker stashes its onEvent under ctx.get('onEvent'); callers that
    // aren't team-scoped won't have it, in which case we pass undefined
    // and the child runs quietly.
    //
    // When we have a parentTaskId (team-scoped run), wrap the parent's
    // onEvent so the child's tool events carry a `spawnMeta` tag — the
    // team-run worker's event bridge reads this and writes each nested
    // tool_call / tool_result into team_messages with the correct
    // `from_member_id` + `metadata.parentTaskId`, so the activity-log UI
    // can render the full delegation tree.
    let onEventFn: SpawnCallbacks['onEvent'] | undefined;
    try {
      const fromCtx = ctx.get<SpawnCallbacks['onEvent'] | null>('onEvent');
      if (typeof fromCtx === 'function') onEventFn = fromCtx;
    } catch {
      onEventFn = undefined;
    }

    let wrappedOnEvent: SpawnCallbacks['onEvent'] | undefined = onEventFn;
    if (onEventFn && parentTaskId) {
      const specialistMemberId = await resolveSpecialistMemberId(
        ctx,
        agent.name,
      );
      // tool-executor plumbs the coord's `tool_use_id` through the
      // per-call ctx proxy. It's the Anthropic-issued anchor the UI
      // uses to nest subagent events under this exact Task card.
      let parentToolUseId = '';
      try {
        const fromCtx = ctx.get<string | null | undefined>('toolUseId');
        if (typeof fromCtx === 'string' && fromCtx.length > 0) {
          parentToolUseId = fromCtx;
        }
      } catch {
        parentToolUseId = '';
      }
      const spawnMeta: StreamEventSpawnMeta = {
        parentTaskId,
        parentToolUseId,
        fromMemberId: specialistMemberId,
        agentName: agent.name,
      };
      wrappedOnEvent = wrapOnEventWithSpawnMeta(onEventFn, spawnMeta);
    }

    const callbacks: SpawnCallbacks | undefined = wrappedOnEvent
      ? { onEvent: wrappedOnEvent }
      : undefined;

    // Resolve the subagent's terminal-output Zod schema. Agents whose
    // AGENT.md frontmatter includes `StructuredOutput` in the tool list
    // (coordinator, content-planner, …) each have a
    // schema registered under `src/tools/AgentTool/agent-schemas.ts` —
    // that schema is handed to runAgent so it synthesizes a validated
    // `StructuredOutput` tool on the subagent's Anthropic tool list. Agents
    // without a registered schema run in plain-text terminal mode.
    const subagentOutputSchema = getAgentOutputSchema(agent.name);

    try {
      const agentResult = await spawnSubagent(
        agent,
        input.prompt,
        ctx,
        callbacks,
        subagentOutputSchema ?? undefined,
        parentTaskId,
      );

      const duration = Date.now() - startedAt;

      if (parentTaskId) {
        await recordTaskComplete(
          ctx,
          parentTaskId,
          agentResult.result,
          agentResult.usage.costUsd,
          agentResult.usage.turns,
        );
      }

      return {
        result: agentResult.result,
        cost: agentResult.usage.costUsd,
        duration,
        turns: agentResult.usage.turns,
      };
    } catch (err) {
      if (parentTaskId) {
        await recordTaskFailure(
          ctx,
          parentTaskId,
          err instanceof Error ? err.message : String(err),
        );
      }
      throw err;
    }
  },
});
