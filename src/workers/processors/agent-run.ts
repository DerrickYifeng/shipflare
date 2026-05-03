// Phase B/C agent-run processor.
//
// Lifecycle (Phase B+C subset):
//   queued → running → (completed | failed | killed)
//
// Phase D adds: sleeping → resuming → running.
// Phase C: mailbox drain at idle turns (mid-run message handling) +
//          shutdown_request triggers graceful exit with status='killed'.
//
// Phase B teammates were SINGLE-SHOT: the processor read its initial
// prompt from the FIRST undelivered `team_messages` row, ran the agent
// to natural completion, synthesized a `<task-notification>` XML, and
// exited.
//
// Phase C extends with a background drain timer (mirrors team-run.ts'
// Task 12 lead-drain pattern): every POLL_INTERVAL_MS the worker calls
// `drainMailbox(agentId)` and pushes the content into a FIFO that
// runAgent reads via `injectMessages` at idle-turn boundaries. If the
// drained batch contains a `shutdown_request`, the worker sets a
// `gracefullyKilled` flag and aborts the in-flight runAgent through
// the AbortController; the catch path then exits cleanly with
// status='killed' (so the synthesized notification carries
// <status>killed</status>).
//
// `parentAgentId` is `null` for Phase B first-spawn teammates because
// the Task tool can't yet point at the parent's agent_runs row (the
// lead is not unified into agent_runs until Phase E). When parent is
// null, `synthAndDeliverNotification` still inserts the
// `task_notification` row (with `toAgentId=null`) so the team-run
// lead's polling drain can pick it up; only the `wake()` call is
// skipped because there's no specific agent_runs row to wake.

import type { Job } from 'bullmq';
import { desc, eq } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import { db } from '@/lib/db';
import type { Database } from '@/lib/db';
import { agentRuns, teamConversations, teamMessages } from '@/lib/db/schema';
import { runAgent } from '@/core/query-loop';
import { resolveAgent } from '@/tools/AgentTool/registry';
import { buildAgentConfigFromDefinition } from '@/tools/AgentTool/spawn';
import { synthesizeTaskNotification } from './lib/synthesize-notification';
import { wake } from './lib/wake';
import { drainMailbox } from './lib/mailbox-drain';
import { loadAgentRunHistory } from './lib/agent-run-history';
import { loadConversationHistory } from '@/lib/team-conversation';
import { createLogger } from '@/lib/logger';
import { getPubSubPublisher } from '@/lib/redis';
import { teamMessagesChannel } from '@/tools/SendMessageTool/SendMessageTool';
import type { AgentRunJobData } from '@/lib/queue/agent-run';
import type { AgentResult, ToolContext } from '@/core/types';

const log = createLogger('agent-run');

// Phase C: how often the background drain polls team_messages for
// mid-run mail addressed to this agent. Mirrors team-run.ts' lead drain
// cadence (POLL_INTERVAL_MS=1s) — see `team-run.ts` Phase B Task 12.
const DRAIN_POLL_INTERVAL_MS = 1000;

// Sentinel string used as the shutdown_reason when a graceful exit is
// triggered by an inbound shutdown_request. Mirrors `TaskStop by lead`
// from the TaskStop tool but is recorded distinctly because the kill
// is observed from the teammate's side here.
const SHUTDOWN_REASON_GRACEFUL = 'shutdown_request received';

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
 * Phase D: `callerAgentId` is injected so the Sleep tool can mark the
 * correct agent_runs row as sleeping. Without it, Sleep would have no
 * way to know which row to update from inside its execute body.
 *
 * `createChildContext` is intentionally NOT used: it takes a real parent
 * ToolContext to inherit deps from, which we don't have at the BullMQ
 * worker entry point.
 */
function buildPhaseBToolContext(
  controller: AbortController,
  agentId: string,
): ToolContext {
  return {
    abortSignal: controller.signal,
    get<V>(key: string): V {
      // Phase D: Sleep tool reads its caller identity from this key.
      if (key === 'callerAgentId') return agentId as unknown as V;
      // Phase B: no other deps wired through. Tools that need a key throw
      // the same "Missing dependency" error they would in any other context.
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

/**
 * Phase E: resolve the team's primary `team_conversations.id` for the
 * lead agent's history load.
 *
 * MVP rule: most recent conversation (by createdAt). Founders typically
 * have a single ongoing thread per team in early Phase E; we'll evolve
 * this once multi-conversation routing lands. Returns `null` for
 * brand-new teams that haven't created a conversation row yet — the
 * lead simply runs without priorMessages in that case (the founder's
 * first message becomes the first turn).
 */
async function resolvePrimaryConversation(
  teamId: string,
  database: Database,
): Promise<string | null> {
  const rows = await database
    .select({ id: teamConversations.id })
    .from(teamConversations)
    .where(eq(teamConversations.teamId, teamId))
    .orderBy(desc(teamConversations.createdAt))
    .limit(1);
  return rows.length > 0 ? rows[0].id : null;
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

  // Load AgentDefinition first — Phase E needs `def.role` to decide
  // whether this run is the team-lead (loads from team_conversations)
  // or a teammate (Phase D resume path keyed off agent_runs row).
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

  const isLead = def.role === 'lead';

  // Resolve priorMessages.
  //
  // Phase E (lead): the team-lead's conversation lives in `team_messages`
  // scoped by `team_conversations.id` — same pattern team-run.ts used
  // before unification (lines 789-801 of the legacy driver). Each lead
  // agent_runs row reuses the team's persistent conversation so the
  // founder sees a single ongoing thread instead of one history-per-run.
  //
  // Phase D (teammate resume): when the row was put to sleep by the
  // Sleep tool on a prior worker invocation, it is woken via either
  // (a) the delayed BullMQ job Sleep scheduled, or (b) a SendMessage
  // that called wake(). Either way we land here with status='sleeping'
  // and rebuild the per-agent transcript via loadAgentRunHistory.
  //
  // Phase B/C (fresh teammate): priorMessages stays undefined; the
  // initial mailbox drain seeds the first user prompt and runAgent
  // builds history from there.
  //
  // Sleeping → resuming → running is preserved for the non-lead resume
  // path; the lead path skips the resuming dance because lead runs are
  // always fresh BullMQ jobs (Phase E API inserts a queued row + wakes).
  let priorMessages: Anthropic.Messages.MessageParam[] | undefined;
  // Phase E hot-fix (working-indicator gap): the lead's agent_text rows AND
  // the SSE payloads MUST carry conversationId so the founder UI's
  // per-conversation thread filter (team-desk.tsx threadMessages) doesn't
  // drop them. Resolve once here and reuse below + at terminal-event time.
  let leadConversationId: string | null = null;
  if (isLead) {
    leadConversationId = await resolvePrimaryConversation(row.teamId, db);
    if (leadConversationId) {
      priorMessages = await loadConversationHistory(row.teamId, {
        conversationId: leadConversationId,
        db,
      });
      log.info(
        `agent-run ${agentId}: lead loaded ${priorMessages.length} messages from conversation ${leadConversationId}`,
      );
    } else {
      log.info(
        `agent-run ${agentId}: lead has no team_conversations row yet — running without priorMessages`,
      );
    }
  } else if (row.status === 'sleeping') {
    await db
      .update(agentRuns)
      .set({
        status: 'resuming',
        lastActiveAt: new Date(),
        bullmqJobId: job.id ?? null,
      })
      .where(eq(agentRuns.id, agentId));
    priorMessages = await loadAgentRunHistory(agentId, db);
    log.info(
      `agent-run ${agentId}: resuming from sleep with ${priorMessages.length} prior messages`,
    );
  }

  // Mark running. (For a non-lead resume, this is the second update —
  // moves the row from 'resuming' to 'running'. For a fresh run or a
  // lead run, this is the only status update before runAgent starts.)
  await db
    .update(agentRuns)
    .set({
      status: 'running',
      lastActiveAt: new Date(),
      bullmqJobId: job.id ?? null,
    })
    .where(eq(agentRuns.id, agentId));

  // Read initial prompt from mailbox (the Task tool inserted it before
  // calling wake()). The first drain still seeds the prompt; Phase C
  // additionally polls for new mail between turns.
  const initialBatch = await drainMailbox(agentId, db);
  const initialPrompt = initialBatch.length > 0 ? (initialBatch[0].content ?? '') : '';
  // Phase E hot-fix (working-indicator gap): the API route at /api/team/run
  // and /api/team/conversations/:id/messages publishes the inbound user_prompt
  // SSE event with `runId = messageId` (the user_prompt row's id is the
  // synthetic "run handle" replacing the deleted team_runs.id). The lead's
  // outputs need to echo the same handle so the founder UI's threadIsLive
  // pairing (team-desk.tsx) can match user_prompt → terminal event and
  // clear the "working..." typing indicator. We only stamp this on SSE
  // payloads (NOT the team_messages.run_id column) because that column is
  // a FK to team_runs which no longer carries a row for the lead.
  const leadRequestId =
    isLead && initialBatch.length > 0 ? initialBatch[0].id : null;

  // Phase C: pendingInjections is the FIFO that the background drain
  // pushes into and runAgent's `injectMessages` callback drains at each
  // idle-turn boundary. Mirrors the team-run lead-drain shape so the
  // Phase E unification is a refactor, not a redesign.
  const pendingInjections: Anthropic.Messages.MessageParam[] = [];
  let gracefullyKilled = false;
  // Phase D: set when the Sleep tool's tool_done event fires with a
  // `{slept: true, ...}` payload. Triggers a graceful early-exit that
  // SKIPS the synthAndDeliverNotification step — the agent isn't done,
  // it's just yielding its worker slot. The Sleep tool itself already
  // marked agent_runs.status='sleeping' before returning.
  let sleepingExit = false;

  const controller = new AbortController();

  // Phase D: composite onEvent handler.
  //
  // Two responsibilities:
  //   1. Detect Sleep tool_done → signal early exit (see Task 4 commit
  //      9e54c88). result.content is JSON-stringified by the tool
  //      executor (src/core/tool-executor.ts:108); parse and check the
  //      `slept: true` marker SleepTool returns.
  //   2. Persist each completed assistant text block to team_messages
  //      so the next resume sees the full prior history. The
  //      `assistant_text_stop` event carries the fully accumulated
  //      `text` for the block — we insert one row per block with
  //      type='agent_text', fromAgentId=self, deliveredAt=now (so
  //      loadAgentRunHistory's `deliveredAt IS NOT NULL` filter sees
  //      it on next resume). Pre-Phase-D runs continue to work because
  //      these rows are additive: the final task_notification row is
  //      still inserted at the end.
  const handleStreamEvent = async (
    event: import('@/core/types').StreamEvent,
  ): Promise<void> => {
    // (2) Persist assistant turns.
    if (event.type === 'assistant_text_stop' && event.text.length > 0) {
      // Generate the row id up front so the SSE publish (lead path) can
      // reference the same id the durable row carries.
      const insertedId = crypto.randomUUID();
      const createdAt = new Date();
      try {
        await db.insert(teamMessages).values({
          id: insertedId,
          teamId: row.teamId,
          // Phase E hot-fix: stamp the lead's primary conversation so the UI's
          // per-thread filter (team-desk.tsx threadMessages) renders this row.
          // Without conversationId the lead's reply would only show after a
          // full page refresh+reroute; meanwhile the typing indicator stays
          // pinned because no agent_text appears in the visible thread.
          conversationId: isLead ? leadConversationId : null,
          type: 'agent_text',
          messageType: 'message',
          fromMemberId: row.memberId,
          fromAgentId: agentId,
          content: event.text,
          deliveredAt: createdAt,
          createdAt,
        });
      } catch (err) {
        log.warn(
          `agent-run ${agentId}: failed to persist assistant turn: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      // Phase E Task 6: lead path additionally publishes to the team SSE
      // channel so the founder UI can paint the assistant turn live.
      // Teammates skip — their output reaches the lead via task_notification
      // mailbox routing, not the team-messages SSE stream.
      // Publish failures are non-fatal: the durable row already landed; SSE
      // is a best-effort live channel and a missed event triggers a refetch
      // on the client side.
      if (def.role === 'lead') {
        try {
          const pub = getPubSubPublisher();
          await pub.publish(
            teamMessagesChannel(row.teamId),
            JSON.stringify({
              messageId: insertedId,
              // Phase E hot-fix: include conversationId + runId so the
              // founder UI's per-conversation thread filter and run-grouping
              // both place this bubble in the right thread, and so the
              // typing-indicator pairing (team-desk.tsx threadIsLive) can
              // match it to the originating user_prompt's runId.
              conversationId: leadConversationId,
              runId: leadRequestId,
              teamId: row.teamId,
              from: row.memberId,
              fromAgentId: agentId,
              type: 'agent_text',
              content: event.text,
              createdAt: createdAt.toISOString(),
            }),
          );
        } catch (err) {
          log.warn(
            `agent-run ${agentId}: SSE publish failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return;
    }

    // (1) Sleep early-exit detection.
    if (event.type !== 'tool_done') return;
    if (event.toolName !== 'Sleep') return;
    if (event.result.is_error) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.result.content);
    } catch {
      return;
    }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'slept' in parsed &&
      (parsed as { slept: unknown }).slept === true
    ) {
      sleepingExit = true;
      log.info(`agent-run ${agentId}: Sleep observed, signalling early exit`);
      try {
        controller.abort();
      } catch {
        // Already aborted — safe to ignore.
      }
    }
  };

  // Phase C: background drain timer. Polls every DRAIN_POLL_INTERVAL_MS
  // for new mail addressed to this agent; on shutdown_request, sets
  // `gracefullyKilled` and aborts the in-flight runAgent so the catch
  // path settles cleanly with status='killed'. Other message types are
  // forwarded to runAgent as user-role injections at the next idle turn.
  const drainTimer: ReturnType<typeof setInterval> = setInterval(() => {
    void drainMailbox(agentId, db)
      .then((batch) => {
        if (batch.length === 0) return;
        for (const msg of batch) {
          if (msg.messageType === 'shutdown_request') {
            gracefullyKilled = true;
            log.info(
              `agent-run ${agentId}: shutdown_request received, signalling graceful exit`,
            );
            // Abort runAgent so the in-flight turn unwinds promptly.
            try {
              controller.abort();
            } catch {
              // Already aborted — safe to ignore.
            }
            // Still inject the shutdown content into the transcript so
            // the agent (if it observes the abort cleanly) has the
            // context for its final wrap-up turn.
          }
          if (msg.content !== null && msg.content.length > 0) {
            pendingInjections.push({ role: 'user', content: msg.content });
          }
        }
      })
      .catch((err) => {
        log.warn(
          `agent-run ${agentId} drain poll failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }, DRAIN_POLL_INTERVAL_MS);
  // Don't keep the worker process alive solely for this timer.
  if (typeof drainTimer.unref === 'function') drainTimer.unref();

  const injectMessages = (): Anthropic.Messages.MessageParam[] => {
    if (pendingInjections.length === 0) return [];
    return pendingInjections.splice(0, pendingInjections.length);
  };

  // Run the agent. Phase C: still single-shot end-to-end, but the
  // injectMessages callback lets mid-run mail land at idle turns and
  // the abort path lets shutdown_request short-circuit cleanly.
  const startedAtMs = Date.now();
  let status: 'completed' | 'failed' | 'killed' = 'completed';
  let summary = '';
  let finalText = '';
  let totalTokens = 0;
  let durationMs = 0;
  let result: AgentResult<unknown> | null = null;

  try {
    const config = buildAgentConfigFromDefinition(def);
    const ctx = buildPhaseBToolContext(controller, agentId);
    result = await runAgent(
      config,
      initialPrompt,
      ctx,
      undefined, // outputSchema
      undefined, // onProgress
      undefined, // prebuilt
      undefined, // onIdleReset
      handleStreamEvent, // onEvent — Phase D Sleep early-exit + per-turn persist
      injectMessages,
      priorMessages, // Phase D: undefined for fresh runs, populated on resume
    );
    durationMs = Date.now() - startedAtMs;
    if (gracefullyKilled) {
      // Agent observed shutdown_request, completed its current turn,
      // and returned cleanly (no abort raised). Treat as graceful kill.
      status = 'killed';
      summary = `${def.name} stopped by shutdown_request`;
      finalText =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
    } else {
      summary = `${def.name} completed in ${result.usage.turns} turns`;
      finalText =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
    }
    totalTokens =
      result.usage.inputTokens +
      result.usage.outputTokens +
      result.usage.cacheReadTokens +
      result.usage.cacheWriteTokens;
  } catch (err) {
    durationMs = Date.now() - startedAtMs;
    if (gracefullyKilled) {
      // Graceful exit triggered by inbound shutdown_request — the
      // Anthropic SDK / our retry helper raises an abort error when
      // controller.abort() fires; treat that as a clean kill, not a
      // failure.
      status = 'killed';
      summary = `${def.name} stopped by shutdown_request`;
      finalText = '';
      totalTokens = 0;
      log.info(`agent-run ${agentId}: graceful kill complete`);
    } else {
      status = 'failed';
      summary = err instanceof Error ? err.message : String(err);
      finalText = '';
      totalTokens = 0;
      log.error('agent-run failed', { agentId, err });
    }
  } finally {
    // Stop the background drain timer.
    clearInterval(drainTimer);
    // Final synchronous drain pass so any last-second arrivals get
    // marked deliveredAt — preventing the reconcile cron from
    // re-enqueueing them. Best-effort; drainMailbox already swallows
    // its own errors via the surrounding try/catch in callers.
    try {
      const finalBatch = await drainMailbox(agentId, db);
      // If we hadn't yet noticed a shutdown_request, the final pass may
      // surface one — promote the exit accordingly so the synthesized
      // notification carries the correct terminal status.
      if (
        !gracefullyKilled &&
        finalBatch.some((m) => m.messageType === 'shutdown_request')
      ) {
        gracefullyKilled = true;
        if (status === 'completed') {
          status = 'killed';
          summary = `${def.name} stopped by shutdown_request`;
        }
      }
    } catch (err) {
      log.warn(
        `agent-run ${agentId} final drain failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Phase D: if the Sleep tool fired during this run, the agent is
  // yielding — not finished. The Sleep tool itself already updated
  // agent_runs.status='sleeping' + sleepUntil and scheduled a delayed
  // wake via enqueueAgentRun. Skip the terminal status update + the
  // task_notification synthesis here; the next agent-run dispatch
  // (from sleep expiry or a wake() triggered by SendMessage) will
  // pick up where this turn left off.
  if (sleepingExit) {
    log.info(`agent-run ${agentId}: yielded for sleep, skipping notification`);
    return;
  }

  // Persist exit state.
  await db
    .update(agentRuns)
    .set({
      status,
      lastActiveAt: new Date(),
      totalTokens,
      // Tool-use counting is not yet plumbed through UsageSummary —
      // Phase D will surface it when the per-turn stream metrics land.
      toolUses: 0,
      shutdownReason:
        status === 'failed'
          ? summary
          : status === 'killed'
            ? SHUTDOWN_REASON_GRACEFUL
            : null,
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

  // Phase E hot-fix (working-indicator gap): publish a terminal SSE event
  // for the lead so the founder UI's typing indicator can clear in real
  // time. The /team thread's `threadIsLive` predicate (team-desk.tsx) pairs
  // the latest user_prompt with any subsequent message of type
  // 'completion' or 'error' carrying the same runId; without that pairing
  // event the indicator is stuck on "working...". team-run.ts used to
  // publish this; Phase E Task 11 deleted that worker and never wired
  // its replacement. We do NOT persist a durable team_messages row here
  // because (a) loadConversationHistory treats 'completion' identically
  // to 'agent_text' and we already inserted those, and (b) the next page
  // refresh derives liveness from the DB rows alone (where runId is null
  // and the predicate falls through cleanly).
  if (def.role === 'lead' && leadRequestId) {
    try {
      const pub = getPubSubPublisher();
      await pub.publish(
        teamMessagesChannel(row.teamId),
        JSON.stringify({
          messageId: crypto.randomUUID(),
          conversationId: leadConversationId,
          runId: leadRequestId,
          teamId: row.teamId,
          from: row.memberId,
          fromAgentId: agentId,
          type: status === 'completed' ? 'completion' : 'error',
          content: status === 'completed' ? '' : summary,
          metadata:
            status === 'killed'
              ? { cancelled: true, reason: SHUTDOWN_REASON_GRACEFUL }
              : status === 'failed'
                ? { error: summary }
                : null,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (err) {
      log.warn(
        `agent-run ${agentId}: terminal SSE publish failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
