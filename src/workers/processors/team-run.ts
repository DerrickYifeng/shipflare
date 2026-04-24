// Phase A Day 4 — BullMQ processor for the team-runs queue.
//
// Job payload: { runId, traceId? }. The processor loads the team_runs row,
// verifies it's still pending/queued, flips status → running, constructs a
// ToolContext with deps needed by SendMessage (+ future team-runtime tools),
// and drives runAgent() on the team's root agent (typically coordinator).
//
// Every assistant message / tool_use / tool_result is persisted to
// team_messages and published to Redis `team:${teamId}:messages` for SSE
// subscribers.

import type { Job } from 'bullmq';
import { and, eq, inArray, not } from 'drizzle-orm';
import { createLogger, loggerForJob } from '@/lib/logger';
import { db, type Database } from '@/lib/db';
import {
  teams,
  teamMembers,
  teamRuns,
  teamMessages,
  teamTasks,
} from '@/lib/db/schema';
import { createPubSubSubscriber, getPubSubPublisher } from '@/lib/redis';
import { runAgent } from '@/core/query-loop';
import { maybeEmitBudgetWarning } from '@/lib/team-budget';
import { buildAgentConfigFromDefinition } from '@/tools/AgentTool/spawn';
import { resolveAgent } from '@/tools/AgentTool/registry';
import { getAgentOutputSchema } from '@/tools/AgentTool/agent-schemas';
import {
  teamCancelChannel,
  teamInjectChannel,
  teamMessagesChannel,
} from '@/tools/SendMessageTool/SendMessageTool';
import type Anthropic from '@anthropic-ai/sdk';
// Side-effect import: registers Task + SendMessage in the global tool
// registry so agents that declare them resolve at runAgent time.
import '@/tools/registry-team';
import type { ToolContext, StreamEvent, StreamEventSpawnMeta } from '@/core/types';
import type { TeamRunJobData } from '@/lib/queue/team-run';

const baseLog = createLogger('worker:team-run');

// ---------------------------------------------------------------------------
// Observability thresholds (Phase G Day 1)
// ---------------------------------------------------------------------------

/**
 * Runs exceeding this duration emit a `team-run-slow` observability alert
 * at completion. Sentry integration is stubbed via structured logs for
 * now; switching to @sentry/nextjs is a one-line replacement in
 * `emitSlowRunAlert`.
 */
export const SLOW_RUN_THRESHOLD_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Concurrency (read by src/workers/index.ts when wiring the Worker instance)
// ---------------------------------------------------------------------------

export const TEAM_RUN_DEFAULT_CONCURRENCY = 3;

export function getTeamRunConcurrency(): number {
  const raw = (process.env.TEAM_RUN_CONCURRENCY ?? '').trim();
  if (raw === '') return TEAM_RUN_DEFAULT_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return TEAM_RUN_DEFAULT_CONCURRENCY;
  return n;
}

// ---------------------------------------------------------------------------
// Persistence helpers (exported for integration testing)
// ---------------------------------------------------------------------------

/**
 * Async subscription handle returned by `TeamRunDeps.subscribeInjections`.
 * Call `unsubscribe()` to tear down the Redis connection on run completion.
 */
export interface InjectSubscription {
  unsubscribe: () => Promise<void>;
}

export interface TeamRunDeps {
  db: Database;
  publish: (channel: string, payload: Record<string, unknown>) => Promise<void>;
  /**
   * Subscribe to user-message injections for a running coordinator.
   * The callback is invoked once per incoming message with the plain text
   * string the user sent. Returns a handle with `unsubscribe()` so the
   * processor can tear the subscriber down when the run ends. Production
   * deps wire this to Redis pub/sub; tests can pass an in-memory variant.
   *
   * When unset (legacy call-sites, pre-Day-3 tests), live injection is a
   * no-op and the coordinator runs on its original goal only.
   */
  subscribeInjections?: (
    teamId: string,
    runId: string,
    onMessage: (content: string) => void,
  ) => Promise<InjectSubscription>;
  /**
   * Subscribe to user-initiated cancellation for a running coordinator.
   * The worker aborts its AbortController when the callback fires,
   * propagating through runAgent into the Anthropic SDK. Returns a
   * handle so the subscriber gets torn down when the run ends. Tests
   * can stub this with a no-op.
   */
  subscribeCancel?: (
    teamId: string,
    runId: string,
    onCancel: () => void,
  ) => Promise<InjectSubscription>;
}

/**
 * Default dep bundle used by the production processor. Tests can hand-build
 * a different bundle and pass it via `processTeamRunInternal` so DB / Redis
 * don't need to be live.
 */
function defaultDeps(): TeamRunDeps {
  return {
    db,
    publish: async (channel, payload) => {
      try {
        await getPubSubPublisher().publish(channel, JSON.stringify(payload));
      } catch (err) {
        // Live delivery only — swallow.
        baseLog.warn(
          `Redis publish to ${channel} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    subscribeInjections: async (teamId, runId, onMessage) => {
      const channel = teamInjectChannel(teamId, runId);
      const sub = createPubSubSubscriber();
      sub.on('message', (_chan, raw) => {
        try {
          const parsed = JSON.parse(raw) as { content?: unknown };
          if (typeof parsed.content === 'string' && parsed.content.length > 0) {
            onMessage(parsed.content);
          }
        } catch (err) {
          baseLog.warn(
            `Redis inject payload parse failed for ${channel}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
      await sub.subscribe(channel);
      return {
        unsubscribe: async () => {
          try {
            await sub.unsubscribe(channel);
          } catch {
            // Already torn down — ignore.
          }
          sub.disconnect();
        },
      };
    },
    subscribeCancel: async (teamId, runId, onCancel) => {
      const channel = teamCancelChannel(teamId, runId);
      const sub = createPubSubSubscriber();
      // The payload is ignored — the cancel channel is a signal, not a
      // message. Any publish on it means "stop this run".
      sub.on('message', () => {
        try {
          onCancel();
        } catch (err) {
          baseLog.warn(
            `cancel handler threw for ${channel}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
      await sub.subscribe(channel);
      return {
        unsubscribe: async () => {
          try {
            await sub.unsubscribe(channel);
          } catch {
            // Already torn down — ignore.
          }
          sub.disconnect();
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Message recording
// ---------------------------------------------------------------------------

interface RecordMessageInput {
  runId: string;
  teamId: string;
  fromMemberId: string | null;
  toMemberId: string | null;
  type:
    | 'user_prompt'
    | 'agent_text'
    | 'tool_call'
    | 'tool_result'
    | 'completion'
    | 'error'
    | 'thinking';
  content: string | null;
  metadata: Record<string, unknown> | null;
}

async function recordMessage(
  deps: TeamRunDeps,
  input: RecordMessageInput,
): Promise<string> {
  const id = crypto.randomUUID();
  const createdAt = new Date();
  await deps.db.insert(teamMessages).values({
    id,
    runId: input.runId,
    teamId: input.teamId,
    fromMemberId: input.fromMemberId,
    toMemberId: input.toMemberId,
    type: input.type,
    content: input.content,
    metadata: input.metadata,
    createdAt,
  });
  await deps.publish(teamMessagesChannel(input.teamId), {
    messageId: id,
    runId: input.runId,
    teamId: input.teamId,
    from: input.fromMemberId,
    to: input.toMemberId,
    type: input.type,
    content: input.content,
    metadata: input.metadata,
    createdAt: createdAt.toISOString(),
  });
  return id;
}

// ---------------------------------------------------------------------------
// Processor entry point
// ---------------------------------------------------------------------------

export async function processTeamRun(job: Job<TeamRunJobData>): Promise<void> {
  const log = loggerForJob(baseLog, job);
  const { runId } = job.data;
  await processTeamRunInternal(runId, defaultDeps(), (msg) => log.info(msg));
}

/**
 * Internal runner that accepts injected deps. Exposed for integration tests
 * so they can drive the full pipeline against in-memory fakes.
 *
 * `rootOutputSchema` is an opt-in for tests / Phase B: when provided,
 * StructuredOutput is synthesized onto the root agent's tool list so its
 * terminal turn emits a validated payload. Production callers from Phase
 * A leave it undefined — the coordinator's schema ships in Phase B.
 */
export async function processTeamRunInternal(
  runId: string,
  deps: TeamRunDeps,
  logLine: (line: string) => void = () => {},
  rootOutputSchema?: import('zod').ZodType<unknown>,
): Promise<void> {
  logLine(`team-run ${runId}: picking up`);

  // --- 1) Load team_runs row ---
  const runRows = await deps.db
    .select({
      id: teamRuns.id,
      teamId: teamRuns.teamId,
      status: teamRuns.status,
      goal: teamRuns.goal,
      rootAgentId: teamRuns.rootAgentId,
      traceId: teamRuns.traceId,
    })
    .from(teamRuns)
    .where(eq(teamRuns.id, runId))
    .limit(1);

  const run = runRows[0];
  if (!run) {
    logLine(`team-run ${runId}: row not found — dropping`);
    return;
  }

  // --- 2) Idempotent gate ---
  // Another worker or an earlier delivery of this job may have already
  // started/finished this run. Accept 'pending' / 'queued' only.
  if (run.status !== 'pending' && run.status !== 'queued') {
    logLine(
      `team-run ${runId}: status=${run.status} — not pending, exiting (idempotent skip)`,
    );
    return;
  }

  // --- 3) Flip to running ---
  // The partial unique index on (team_id) WHERE status='running' will reject a
  // parallel run for the same team — in that case we surface the failure so
  // BullMQ can mark the job failed (no retry, attempts=1).
  const runStartedAt = new Date();
  await deps.db
    .update(teamRuns)
    .set({ status: 'running', startedAt: runStartedAt })
    .where(eq(teamRuns.id, runId));

  // --- 4) Load team + members ---
  const teamRows = await deps.db
    .select({
      id: teams.id,
      userId: teams.userId,
      productId: teams.productId,
    })
    .from(teams)
    .where(eq(teams.id, run.teamId))
    .limit(1);

  const team = teamRows[0];
  if (!team) {
    await markFailed(deps, runId, `team ${run.teamId} not found`);
    return;
  }

  const members = await deps.db
    .select({
      id: teamMembers.id,
      agentType: teamMembers.agentType,
      displayName: teamMembers.displayName,
    })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, team.id));

  const rootMember = members.find((m) => m.id === run.rootAgentId);
  if (!rootMember) {
    await markFailed(
      deps,
      runId,
      `root_agent_id ${run.rootAgentId} not a member of team ${team.id}`,
    );
    return;
  }

  // --- 5) Resolve AGENT.md definition for the root agent ---
  const agentDef = await resolveAgent(rootMember.agentType);
  if (!agentDef) {
    await markFailed(
      deps,
      runId,
      `no AGENT.md registered for agent_type="${rootMember.agentType}" (member ${rootMember.id})`,
    );
    return;
  }

  const agentConfig = buildAgentConfigFromDefinition(agentDef);

  // Resolve the per-agent StructuredOutput schema. Tests pass
  // `rootOutputSchema` directly to override this lookup with a fixture-
  // specific shape; production callers let it fall through to the
  // registered schema (coordinator, growth-strategist, content-planner).
  const resolvedSchema: import('zod').ZodType<unknown> | undefined =
    rootOutputSchema ?? getAgentOutputSchema(rootMember.agentType) ?? undefined;

  // --- 6) Record the user_prompt seed message ---
  // Skip when the run already has a user_prompt row — that happens when
  // /api/team/message enqueued this run: it persists the user's brief up
  // front (for immediate bubble + SSE echo) and the run inherits
  // `goal = body.message`. Re-inserting the seed here would render two
  // identical user bubbles back-to-back.
  const existingPromptRows = await deps.db
    .select({ id: teamMessages.id })
    .from(teamMessages)
    .where(
      and(eq(teamMessages.runId, runId), eq(teamMessages.type, 'user_prompt')),
    )
    .limit(1);

  if (existingPromptRows.length === 0) {
    await recordMessage(deps, {
      runId,
      teamId: team.id,
      fromMemberId: null, // user
      toMemberId: rootMember.id,
      type: 'user_prompt',
      content: run.goal,
      metadata: { trigger: 'team_run_start', traceId: run.traceId ?? null },
    });
  }

  // --- 7) Build ToolContext with deps ---
  const controller = new AbortController();
  // `onEvent` is plumbed through the ToolContext so nested subagents
  // (spawned via Task) can forward their tool_start / tool_done events
  // to the same team_messages channel without re-plumbing the deps. The
  // Task tool reads this off the ctx and passes it to spawnSubagent's
  // nested runAgent call. Declared as a container upfront so it can be
  // closed over by the getter below, then filled after toolCtx exists.
  const onEventHolder: { fn: ((event: StreamEvent) => Promise<void>) | null } =
    { fn: null };
  const toolCtx: ToolContext = {
    abortSignal: controller.signal,
    get<V>(key: string): V {
      switch (key) {
        case 'db':
          return deps.db as unknown as V;
        case 'teamId':
          return team.id as unknown as V;
        case 'userId':
          return team.userId as unknown as V;
        case 'productId':
          return (team.productId ?? null) as unknown as V;
        case 'runId':
          return runId as unknown as V;
        case 'currentMemberId':
          return rootMember.id as unknown as V;
        case 'onEvent':
          return onEventHolder.fn as unknown as V;
        default:
          throw new Error(`Missing dependency: ${key}`);
      }
    },
  };
  onEventHolder.fn = (event: StreamEvent) =>
    emitToolEvent(deps, toolCtx, event);

  // --- 8) Attach stream-event → team_messages bridge ---
  // runAgent exposes `onProgress` for coarse-grained signals; the
  // query-loop's full StreamEvent stream is plumbed via ToolContext at the
  // tool_executor level. We convert the subset we care about (tool_start /
  // tool_done) into team_messages rows. Text blocks are added from the
  // agent result on completion.
  //
  // (tool_executor emits StreamEvents via the `onEvent` arg to executeTools;
  // runAgent currently only forwards via onProgress. We persist tool I/O
  // through the separate mechanism below: runAgent passes through to
  // executeTools which calls our onEvent wrapper. For Phase A Day 4 we
  // persist tool events synchronously via a scoped wrapper that the runner
  // invokes per tool call.)

  // --- 9) Wire live message injection ---
  // FIFO of user messages pushed in while the coordinator is mid-run. Each
  // turn, runAgent calls `injectMessages()`, which drains this queue and
  // returns plain user-role MessageParams — the coordinator reads them on
  // its next turn and can adapt its plan.
  const pendingInjections: Anthropic.Messages.MessageParam[] = [];
  let injectSub: InjectSubscription | null = null;
  if (deps.subscribeInjections) {
    try {
      injectSub = await deps.subscribeInjections(team.id, runId, (content) => {
        pendingInjections.push({ role: 'user', content });
      });
    } catch (err) {
      // Subscription is best-effort — a Redis failure must not block the
      // run from starting. Log and carry on; the coordinator will just
      // miss live messages for this run.
      baseLog.warn(
        `subscribeInjections failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- 9b) Wire cancellation signal ---
  // `/api/team/run/[runId]/cancel` publishes on this channel when the
  // user hits the Stop button in the composer. Aborting the controller
  // flows through runAgent → Anthropic SDK, which raises
  // `APIUserAbortError` from the stream reader — we catch it below and
  // settle the run as `cancelled`.
  let cancelRequested = false;
  let cancelSub: InjectSubscription | null = null;
  if (deps.subscribeCancel) {
    try {
      cancelSub = await deps.subscribeCancel(team.id, runId, () => {
        cancelRequested = true;
        logLine(`team-run ${runId}: cancellation requested, aborting`);
        try {
          controller.abort();
        } catch {
          // Already aborted — safe to ignore.
        }
      });
    } catch (err) {
      baseLog.warn(
        `subscribeCancel failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const injectMessages = (): Anthropic.Messages.MessageParam[] => {
    if (pendingInjections.length === 0) return [];
    return pendingInjections.splice(0, pendingInjections.length);
  };

  // --- 10) Run! ---
  try {
    const result = await runAgent(
      agentConfig,
      run.goal,
      toolCtx,
      resolvedSchema,
      undefined, // onProgress
      undefined, // prebuilt
      undefined, // onIdleReset
      (event) => emitToolEvent(deps, toolCtx, event),
      injectMessages,
    );

    // Persist agent's final text block (if any) as a completion message.
    const finalText =
      typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result);

    await recordMessage(deps, {
      runId,
      teamId: team.id,
      fromMemberId: rootMember.id,
      toMemberId: null, // broadcast / user
      type: 'completion',
      content: finalText,
      metadata: {
        cost: result.usage.costUsd,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        turns: result.usage.turns,
      },
    });

    const completedAt = new Date();
    const startedAtMs = runStartedAt.getTime();
    const durationMs = completedAt.getTime() - startedAtMs;

    // Phase G Day 1: team_runs.total_cost_usd aggregates the root agent's
    // cost (result.usage.costUsd) + every nested spawn's cost recorded
    // in team_tasks.cost_usd. runAgent's usage only tracks the call it
    // made directly; costs inside Task-spawned subagents live on their
    // respective team_tasks rows, so we SUM them back in here.
    const childTasks = await deps.db
      .select({ costUsd: teamTasks.costUsd })
      .from(teamTasks)
      .where(eq(teamTasks.runId, runId));
    const childCostUsd = childTasks.reduce(
      (acc, row) => acc + Number(row.costUsd ?? 0),
      0,
    );
    const aggregateCostUsd = result.usage.costUsd + childCostUsd;

    // Guard against racing with a user-initiated cancel: the cancel
    // route may have flipped the row to `cancelled` milliseconds before
    // the worker's last turn finished. Only promote to `completed` if
    // the row is still `running` — otherwise the user's Stop click
    // would be silently overwritten.
    await deps.db
      .update(teamRuns)
      .set({
        status: 'completed',
        completedAt,
        totalCostUsd: String(aggregateCostUsd),
        totalTurns: result.usage.turns,
      })
      .where(
        and(
          eq(teamRuns.id, runId),
          not(inArray(teamRuns.status, ['cancelled', 'completed', 'failed'])),
        ),
      );

    logLine(
      `team-run ${runId}: completed (cost=$${aggregateCostUsd.toFixed(4)} ` +
        `[root=$${result.usage.costUsd.toFixed(4)}, spawns=$${childCostUsd.toFixed(4)}], ` +
        `turns=${result.usage.turns}, duration=${durationMs}ms)`,
    );

    // Phase G Day 1: slow-run alert. Run durations over the threshold emit
    // a structured observability log that a Sentry integration can tail on.
    if (durationMs >= SLOW_RUN_THRESHOLD_MS) {
      baseLog.warn(
        `observability:slow-run team=${team.id} run=${runId} ` +
          `durationMs=${durationMs} thresholdMs=${SLOW_RUN_THRESHOLD_MS} ` +
          `cost=$${aggregateCostUsd.toFixed(4)} turns=${result.usage.turns}`,
      );
    }

    // Structured-output retry alert (spec §11 Phase G Day 1). The
    // query-loop reports per-turn retry counts on usage; surface as
    // observability signal when a run accumulated 3+ retries — a prompt-
    // tuning smell.
    const retryCount = (result.usage as unknown as { structuredOutputRetries?: number })
      .structuredOutputRetries;
    if (typeof retryCount === 'number' && retryCount >= 3) {
      baseLog.warn(
        `observability:structured-output-retries team=${team.id} run=${runId} retries=${retryCount}`,
      );
    }

    // Phase G Day 2: after every completed run, check whether the team
    // has crossed the 90% weekly budget threshold. Emits at most once per
    // (team, week) via Redis dedupe; the sink defaults to a structured
    // observability log until email infra ships.
    try {
      await maybeEmitBudgetWarning(team.id, deps.db);
    } catch (err) {
      baseLog.warn(
        `budget warning check failed for team=${team.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // User-initiated cancel: the Anthropic SDK raises APIUserAbortError
    // when our controller fires, plus a plain `Aborted` from our
    // createMessage retry helper. Both land here; detect via the
    // `cancelRequested` flag we set inside the cancel subscriber, and
    // settle the run as `cancelled` instead of `failed` so the UI
    // colors it muted instead of red.
    if (cancelRequested) {
      logLine(`team-run ${runId}: cancelled by user`);
      await markCancelled(deps, runId);
      // Publish a terminal event so the client can flip the session
      // status without waiting for the next snapshot refresh.
      try {
        await deps.publish(teamMessagesChannel(team.id), {
          messageId: crypto.randomUUID(),
          runId,
          teamId: team.id,
          from: rootMember.id,
          to: null,
          type: 'error',
          content: 'Run cancelled by user.',
          metadata: { cancelled: true },
          createdAt: new Date().toISOString(),
        });
      } catch {
        // Best-effort — DB status is the source of truth.
      }
      return;
    }
    await recordMessage(deps, {
      runId,
      teamId: team.id,
      fromMemberId: rootMember.id,
      toMemberId: null,
      type: 'error',
      content: message,
      metadata: null,
    });
    await markFailed(deps, runId, message);
    throw err;
  } finally {
    if (injectSub) {
      try {
        await injectSub.unsubscribe();
      } catch (err) {
        baseLog.warn(
          `inject subscriber teardown failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (cancelSub) {
      try {
        await cancelSub.unsubscribe();
      } catch (err) {
        baseLog.warn(
          `cancel subscriber teardown failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

async function markCancelled(
  deps: TeamRunDeps,
  runId: string,
): Promise<void> {
  await deps.db
    .update(teamRuns)
    .set({
      status: 'cancelled',
      completedAt: new Date(),
    })
    .where(eq(teamRuns.id, runId));
}

async function markFailed(
  deps: TeamRunDeps,
  runId: string,
  message: string,
): Promise<void> {
  // Same cancel-race guard as the completion branch — a user's Stop
  // click wins over a late `failed` write from the worker's own catch.
  await deps.db
    .update(teamRuns)
    .set({
      status: 'failed',
      completedAt: new Date(),
      errorMessage: message,
    })
    .where(
      and(
        eq(teamRuns.id, runId),
        not(inArray(teamRuns.status, ['cancelled', 'completed', 'failed'])),
      ),
    );
}

// ---------------------------------------------------------------------------
// Stream-event bridge used by tools (see src/tools/AgentTool/AgentTool.ts
// +  future Task tool callbacks). Kept here because it reads team-run
// context, not Task internals.
// ---------------------------------------------------------------------------

/**
 * Helper exposed for future wiring: given a ToolContext from a team run,
 * write a tool_call / tool_result message pair to the DB + SSE channel.
 * Phase A Day 4 leaves this untapped; Phase D hooks it into the Task tool's
 * spawn-start / spawn-end callbacks.
 *
 * Exported here so Phase D can reuse the recording primitive without
 * duplicating the insert+publish logic.
 */
export async function emitToolEvent(
  deps: TeamRunDeps,
  ctx: ToolContext,
  event: StreamEvent,
): Promise<void> {
  let teamId: string;
  let runId: string;
  let callerMemberId: string | null = null;
  try {
    teamId = ctx.get<string>('teamId');
    runId = ctx.get<string>('runId');
    try {
      callerMemberId = ctx.get<string>('currentMemberId');
    } catch {
      callerMemberId = null;
    }
  } catch {
    // Not a team-run context — nothing to record.
    return;
  }

  // When the event was emitted inside a subagent spawned via Task, the
  // Task tool has augmented it with a `spawnMeta` tag pointing at the
  // spawning team_tasks row + the specialist's team_members row (when
  // resolvable). We use that to attribute the message to the specialist
  // and record `parentTaskId` on metadata so the UI can render a tree.
  if (
    event.type === 'assistant_text_start' ||
    event.type === 'assistant_text_delta' ||
    event.type === 'assistant_text_stop'
  ) {
    // When the event came from a subagent spawn, the Task tool wraps
    // onEvent with `wrapOnEventWithSpawnMeta` which stamps spawnMeta
    // on every tag-aware event — including these text-streaming ones.
    // Attribute the row to the specialist member (if resolvable) and
    // carry `parentToolUseId` in metadata so the UI can nest.
    const assistantSpawn = event.spawnMeta;
    const textFromMemberId = assistantSpawn?.fromMemberId ?? callerMemberId;
    await emitAssistantTextEvent(deps, {
      teamId,
      runId,
      fromMemberId: textFromMemberId,
      spawnMeta: assistantSpawn ?? null,
      event,
    });
    return;
  }

  if (event.type === 'tool_input_delta') {
    // Ephemeral streaming of the LLM's tool-input JSON as it arrives.
    // No DB write — the durable `tool_call` row lands later via
    // emitToolEvent's `tool_start` path. Publish only; the client
    // accumulates partials keyed by toolUseId and clears on tool_call.
    try {
      await deps.publish(teamMessagesChannel(teamId), {
        messageId: event.toolUseId,
        runId,
        teamId,
        from: callerMemberId,
        to: null,
        type: 'tool_input_delta',
        content: event.jsonDelta,
        metadata: { turn: event.turn, blockIndex: event.blockIndex },
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      baseLog.warn(
        `tool_input_delta publish failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  if (event.type !== 'tool_start' && event.type !== 'tool_done') return;

  const spawnMeta = event.spawnMeta;
  const fromMemberId = spawnMeta?.fromMemberId ?? callerMemberId;

  if (event.type === 'tool_start') {
    await recordMessage(deps, {
      runId,
      teamId,
      fromMemberId,
      toMemberId: null,
      type: 'tool_call',
      content: null,
      metadata: {
        toolName: event.toolName,
        toolUseId: event.toolUseId,
        input: event.input,
        ...(spawnMeta
          ? {
              parentTaskId: spawnMeta.parentTaskId,
              parentToolUseId: spawnMeta.parentToolUseId,
              agentName: spawnMeta.agentName,
            }
          : {}),
      },
    });
    return;
  }
  if (event.type === 'tool_done') {
    await recordMessage(deps, {
      runId,
      teamId,
      fromMemberId,
      toMemberId: null,
      type: 'tool_result',
      content: event.result.content,
      metadata: {
        toolName: event.toolName,
        toolUseId: event.toolUseId,
        isError: event.result.is_error ?? false,
        durationMs: event.durationMs,
        ...(spawnMeta
          ? {
              parentTaskId: spawnMeta.parentTaskId,
              parentToolUseId: spawnMeta.parentToolUseId,
              agentName: spawnMeta.agentName,
            }
          : {}),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Assistant-text streaming forwarder
// ---------------------------------------------------------------------------

interface AssistantTextContext {
  teamId: string;
  runId: string;
  fromMemberId: string | null;
  spawnMeta: StreamEventSpawnMeta | null;
  event:
    | { type: 'assistant_text_start'; messageId: string; turn: number; blockIndex: number }
    | {
        type: 'assistant_text_delta';
        messageId: string;
        turn: number;
        blockIndex: number;
        delta: string;
      }
    | {
        type: 'assistant_text_stop';
        messageId: string;
        turn: number;
        blockIndex: number;
        text: string;
      };
}

/**
 * Fan out streaming assistant text into two lanes:
 *
 *   1. `assistant_text_start` / `_delta`  → published live to Redis so
 *      the client's `useTeamEvents` can paint the partial bubble with a
 *      breathing indicator. No DB write — deltas are ephemeral.
 *
 *   2. `assistant_text_stop`              → insert one `agent_text` row
 *      in `team_messages` using the **same** messageId the partial ran
 *      under, then publish the final. The client sees the id match and
 *      swaps the partial bubble for the durable one without flicker.
 *
 * If Redis publish fails mid-stream we log and move on — the stop event
 * still lands in the DB, so the conversation is never silently lost; the
 * worst case is the user misses the typing animation.
 */
async function emitAssistantTextEvent(
  deps: TeamRunDeps,
  ctx: AssistantTextContext,
): Promise<void> {
  const { teamId, runId, fromMemberId, spawnMeta, event } = ctx;

  // Every publish carries the nesting anchors when present, so the
  // client's reducer can route the row to the right dispatch card.
  const nestingMetadata = spawnMeta
    ? {
        parentTaskId: spawnMeta.parentTaskId,
        parentToolUseId: spawnMeta.parentToolUseId,
        agentName: spawnMeta.agentName,
      }
    : {};

  if (event.type === 'assistant_text_start') {
    await safePublish(deps, teamId, {
      messageId: event.messageId,
      runId,
      teamId,
      from: fromMemberId,
      to: null,
      type: 'agent_text_start',
      content: null,
      metadata: {
        turn: event.turn,
        blockIndex: event.blockIndex,
        ...nestingMetadata,
      },
      createdAt: new Date().toISOString(),
    });
    return;
  }

  if (event.type === 'assistant_text_delta') {
    await safePublish(deps, teamId, {
      messageId: event.messageId,
      runId,
      teamId,
      from: fromMemberId,
      to: null,
      type: 'agent_text_delta',
      content: event.delta,
      metadata: {
        turn: event.turn,
        blockIndex: event.blockIndex,
        ...nestingMetadata,
      },
      createdAt: new Date().toISOString(),
    });
    return;
  }

  // stop: record the full text to the DB, then broadcast. Re-uses the
  // same messageId the partial carried so the client swaps in place.
  if (event.text.length === 0) {
    // Empty block — skip the DB write but still notify so the client
    // can clear its partial state.
    await safePublish(deps, teamId, {
      messageId: event.messageId,
      runId,
      teamId,
      from: fromMemberId,
      to: null,
      type: 'agent_text_stop',
      content: null,
      metadata: {
        turn: event.turn,
        blockIndex: event.blockIndex,
        ...nestingMetadata,
      },
      createdAt: new Date().toISOString(),
    });
    return;
  }

  const createdAt = new Date();
  await deps.db.insert(teamMessages).values({
    id: event.messageId,
    runId,
    teamId,
    fromMemberId,
    toMemberId: null,
    type: 'agent_text',
    content: event.text,
    metadata: {
      turn: event.turn,
      blockIndex: event.blockIndex,
      ...nestingMetadata,
    },
    createdAt,
  });
  await safePublish(deps, teamId, {
    messageId: event.messageId,
    runId,
    teamId,
    from: fromMemberId,
    to: null,
    type: 'agent_text',
    content: event.text,
    metadata: {
      turn: event.turn,
      blockIndex: event.blockIndex,
      ...nestingMetadata,
    },
    createdAt: createdAt.toISOString(),
  });
}

async function safePublish(
  deps: TeamRunDeps,
  teamId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.publish(teamMessagesChannel(teamId), payload);
  } catch (err) {
    baseLog.warn(
      `safePublish failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

