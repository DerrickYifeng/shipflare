// Phase B agent-run processor.
//
// Lifecycle (Phase B subset):
//   queued → running → (completed | failed)
//
// Phase D adds: sleeping → resuming → running.
// Phase C adds: mailbox drain at idle turns (mid-run message handling).
//
// Phase B teammates are SINGLE-SHOT: the processor reads its initial prompt
// from the FIRST undelivered `team_messages` row addressed to its agentId
// (which the Task tool's async branch inserted before calling `wake()`),
// runs the agent to natural completion (`end_turn` / `maxTurns` / error),
// synthesizes a `<task-notification>` XML, inserts it into team_messages
// for the parent, and exits.
//
// `parentAgentId` is `null` for Phase B first-spawn teammates because the
// Task tool can't yet point at the parent's agent_runs row (the lead is
// not unified into agent_runs until Phase E). When parent is null,
// `synthAndDeliverNotification` still inserts the `task_notification` row
// (with `toAgentId=null`) so the team-run lead's polling drain can pick
// it up; only the `wake()` call is skipped because there's no specific
// agent_runs row to wake. Phase E will replace the polling drain with
// proper wake routing once the lead has its own agent_runs row.

import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRuns, teamMessages } from '@/lib/db/schema';
import { runAgent } from '@/core/query-loop';
import { resolveAgent } from '@/tools/AgentTool/registry';
import { buildAgentConfigFromDefinition } from '@/tools/AgentTool/spawn';
import { synthesizeTaskNotification } from './lib/synthesize-notification';
import { wake } from './lib/wake';
import { drainMailbox } from './lib/mailbox-drain';
import { createLogger } from '@/lib/logger';
import type { AgentRunJobData } from '@/lib/queue/agent-run';
import type { AgentResult, ToolContext } from '@/core/types';

const log = createLogger('agent-run');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal synthetic ToolContext for a Phase B teammate run. Tools
 * that require richer deps (db / teamId / userId / platform clients) are
 * NOT yet plumbed here — Phase B teammates run with the agent definition's
 * declared tool list only, which for the first wave (content-manager etc.)
 * is mostly self-contained. Phase E will replace this stub with a proper
 * teammate context that mirrors the team-run worker's shape.
 *
 * `createChildContext` is intentionally NOT used: it takes a real parent
 * ToolContext to inherit deps from, which we don't have at the BullMQ
 * worker entry point.
 */
function buildPhaseBToolContext(controller: AbortController): ToolContext {
  return {
    abortSignal: controller.signal,
    get<V>(key: string): V {
      // Phase B: no deps wired through. Tools that need a key throw the
      // same "Missing dependency" error they would in any other context.
      throw new Error(`Missing dependency: ${key}`);
    },
  };
}

async function markFailed(agentId: string, reason: string): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      status: 'failed',
      shutdownReason: reason,
      lastActiveAt: new Date(),
    })
    .where(eq(agentRuns.id, agentId));
}

interface NotifyParams {
  agentId: string;
  parentAgentId: string | null;
  teamId: string;
  memberId: string;
  status: 'completed' | 'failed' | 'killed';
  finalText: string;
  summary: string;
  usage: { totalTokens: number; toolUses: number; durationMs: number };
}

// Phase B vs Phase E behavior:
//   - Phase B: `parentAgentId` is `null` for first-spawn teammates because
//     the team-run lead does not yet have an `agent_runs` row. We still
//     insert the `task_notification` row (with `toAgentId=null`) so the
//     team-run worker's polling drain (Task 12) can pick it up. We skip
//     `wake()` because there is no specific agent_runs row to wake — the
//     lead is on a polling loop, not a sleeping/resuming cycle.
//   - Phase E: once the lead is unified into `agent_runs`, `parentAgentId`
//     will be non-null and we route the notification directly via `wake()`,
//     removing the need for the polling drain.
async function synthAndDeliverNotification(params: NotifyParams): Promise<void> {
  const xml = synthesizeTaskNotification({
    agentId: params.agentId,
    status: params.status,
    summary: params.summary,
    finalText: params.finalText,
    usage: params.usage,
  });

  await db.insert(teamMessages).values({
    teamId: params.teamId,
    type: 'user_prompt',
    messageType: 'task_notification',
    fromMemberId: params.memberId,
    fromAgentId: params.agentId,
    toAgentId: params.parentAgentId, // null in Phase B (lead has no agent_runs row yet)
    content: xml,
    summary: params.summary,
  });

  // Phase B: when parentAgentId is null, the team-run drain (Task 12) polls
  // for these notifications. No wake() needed because there's no agentRun
  // for the lead yet (Phase E adds proper wake routing).
  if (params.parentAgentId) {
    await wake(params.parentAgentId);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function processAgentRun(job: Job<AgentRunJobData>): Promise<void> {
  const { agentId } = job.data;

  const row = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, agentId),
  });
  if (!row) {
    throw new Error(`agent_runs row not found for agentId=${agentId}`);
  }

  // Mark running
  await db
    .update(agentRuns)
    .set({
      status: 'running',
      lastActiveAt: new Date(),
      bullmqJobId: job.id ?? null,
    })
    .where(eq(agentRuns.id, agentId));

  // Load AgentDefinition
  const def = await resolveAgent(row.agentDefName);
  if (!def) {
    const reason = `unknown agent: ${row.agentDefName}`;
    await markFailed(agentId, reason);
    await synthAndDeliverNotification({
      agentId,
      parentAgentId: row.parentAgentId,
      teamId: row.teamId,
      memberId: row.memberId,
      status: 'failed',
      finalText: '',
      summary: reason,
      usage: { totalTokens: 0, toolUses: 0, durationMs: 0 },
    });
    return;
  }

  // Read initial prompt from mailbox (the Task tool inserted it before
  // calling wake()). Phase B is single-shot — we drain once at start and
  // use the first message as the user prompt.
  const batch = await drainMailbox(agentId, db);
  const initialPrompt = batch.length > 0 ? (batch[0].content ?? '') : '';

  // Run the agent. Phase B: single-shot, run to natural completion.
  const startedAtMs = Date.now();
  const controller = new AbortController();
  let status: 'completed' | 'failed' = 'completed';
  let summary = '';
  let finalText = '';
  let totalTokens = 0;
  let durationMs = 0;
  let result: AgentResult<unknown> | null = null;

  try {
    const config = buildAgentConfigFromDefinition(def);
    const ctx = buildPhaseBToolContext(controller);
    result = await runAgent(config, initialPrompt, ctx);
    durationMs = Date.now() - startedAtMs;
    summary = `${def.name} completed in ${result.usage.turns} turns`;
    finalText =
      typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result);
    totalTokens =
      result.usage.inputTokens +
      result.usage.outputTokens +
      result.usage.cacheReadTokens +
      result.usage.cacheWriteTokens;
  } catch (err) {
    status = 'failed';
    durationMs = Date.now() - startedAtMs;
    summary = err instanceof Error ? err.message : String(err);
    finalText = '';
    totalTokens = 0;
    log.error('agent-run failed', { agentId, err });
  }

  // Persist exit state.
  await db
    .update(agentRuns)
    .set({
      status,
      lastActiveAt: new Date(),
      totalTokens,
      // Tool-use counting is not yet plumbed through UsageSummary — Phase D
      // will surface it when the per-turn stream metrics land. Default 0.
      toolUses: 0,
      shutdownReason: status === 'failed' ? summary : null,
    })
    .where(eq(agentRuns.id, agentId));

  await synthAndDeliverNotification({
    agentId,
    parentAgentId: row.parentAgentId,
    teamId: row.teamId,
    memberId: row.memberId,
    status,
    finalText,
    summary,
    usage: {
      totalTokens,
      toolUses: 0,
      durationMs,
    },
  });
}
