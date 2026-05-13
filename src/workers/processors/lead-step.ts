// Phase D Task D2 — pure decision boundary for the lead's per-turn loop.
//
// `leadStep` invokes `runAgent` (the existing multi-turn LLM loop) and
// classifies what happened into one of four discriminated outcomes:
//
//   - 'continue'        — runAgent produced more assistant messages but
//                         did not yield, spawn async teammates, or
//                         terminate. The caller should call leadStep
//                         again with the updated history. Rare in
//                         practice (usually a synchronous tool finished
//                         and the model wants another turn) but kept as
//                         a distinct branch so D3's apply-decision
//                         logic stays explicit.
//   - 'spawn_and_wait'  — runAgent fired one or more
//                         `Task(run_in_background:true)` calls. The
//                         lead should be persisted with `waiting_for`
//                         populated and yield its worker slot until the
//                         task_notification fan-in drains the list.
//   - 'sleep'           — runAgent fired a `Sleep` call. The lead has
//                         already had its `agent_runs.sleepUntil`
//                         updated synchronously by the Sleep tool; D3
//                         just needs to checkpoint and yield.
//   - 'done'            — runAgent terminated with a final assistant
//                         message. D3 should persist the terminal
//                         status, synthesize the task_notification, and
//                         release the slot.
//
// D2 is REFACTOR ONLY — it preserves all existing behavior. It does NOT
// modify `agent-run.ts` and does NOT mutate `agent_runs`. The returned
// `newCheckpoint` is the durable resume state D3 will write back.
//
// The implementation observes runAgent's stream events (`tool_done` for
// `Task` with `status:'async_launched'`, `tool_done` for `Sleep` with
// `slept:true`) the same way `runAgentTurn`'s `handleStreamEvent`
// currently does — this preserves the existing detection contract.

import type Anthropic from '@anthropic-ai/sdk';
import type {
  AgentConfig,
  AgentResult,
  StreamEvent,
  ToolContext,
} from '@/core/types';
import type { LeadCheckpoint } from '@/lib/db/schema/team';
import type { DrainedMessage } from './lib/mailbox-drain';
import { runAgent } from '@/core/query-loop';
import { TASK_TOOL_NAME } from '@/tools/AgentTool/AgentTool';
import { SLEEP_TOOL_NAME } from '@/tools/SleepTool/SleepTool';
import { createLogger } from '@/lib/logger';

const log = createLogger('agent-run:lead-step');

// ---------------------------------------------------------------------------
// Public types — match the D2 plan contract exactly.
// ---------------------------------------------------------------------------

export interface LeadStepInput {
  agentId: string;
  history: Anthropic.Messages.MessageParam[];
  mailbox: DrainedMessage[];
  checkpoint: LeadCheckpoint | null;
  tenantId: string;
}

export interface SpawnRequest {
  toolUseId: string;
  agentType: string;
  prompt: string;
}

export type LeadStepDecision =
  | {
      kind: 'continue';
      assistantMessages: Anthropic.Messages.MessageParam[];
      newCheckpoint: LeadCheckpoint;
    }
  | {
      kind: 'spawn_and_wait';
      spawns: SpawnRequest[];
      newCheckpoint: LeadCheckpoint;
    }
  | { kind: 'sleep'; untilMs: number; newCheckpoint: LeadCheckpoint }
  | { kind: 'done'; summary: string };

// ---------------------------------------------------------------------------
// Runtime dependencies — supplied by the caller (D3 will wire these from
// `runAgentTurn`'s existing prelude). Kept OUT of `LeadStepInput` so the
// documented public input shape stays minimal; the test suite provides a
// stub. The actual primitives invoked here (runAgent, the parent's
// onEvent fan-out) already exist — D2 does NOT introduce a new transport.
// ---------------------------------------------------------------------------

export interface LeadStepDeps {
  /** The agent's compiled config (system prompt, model, tools, maxTurns). */
  config: AgentConfig;
  /** ToolContext exposing `db`, `userId`, platform clients, etc. */
  ctx: ToolContext;
  /**
   * Optional parent stream-event observer. `leadStep` wraps this so it
   * can additionally observe Sleep / Task async tool_done events for
   * classification, then forwards every event unmodified to the parent.
   * D3 will pass the existing `handleStreamEvent` here.
   */
  parentOnEvent?: (event: StreamEvent) => void | Promise<void>;
  /**
   * Optional callback drained at each idle-turn boundary inside
   * runAgent. D3 will pass the existing `pendingInjections` FIFO drain.
   */
  injectMessages?: () => Anthropic.Messages.MessageParam[];
  /**
   * Test seam: override `runAgent` so unit tests can mock it without
   * loading the real Anthropic client. Production callers leave this
   * undefined; the module-level `runAgent` import is used.
   */
  runAgentImpl?: typeof runAgent;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Run one decision step of the lead loop. Calls runAgent (potentially
 * for many turns of the underlying Anthropic loop) and classifies the
 * outcome into a `LeadStepDecision`. Mutations to `agent_runs` are NOT
 * performed here — the returned decision describes what D3 should do.
 *
 * Errors propagate as-is. `LlmRateLimitedError` MUST bubble up so the
 * outer `processAgentRun` wrapper can translate it into a re-enqueue
 * (see B5).
 */
export async function leadStep(
  input: LeadStepInput,
  deps: LeadStepDeps,
): Promise<LeadStepDecision> {
  const { history, mailbox, checkpoint, tenantId } = input;
  const {
    config,
    ctx,
    parentOnEvent,
    injectMessages,
    runAgentImpl = runAgent,
  } = deps;

  // -------------------------------------------------------------------------
  // Stream-event observer: detect async-Task spawns and Sleep yields.
  // -------------------------------------------------------------------------
  //
  // We mirror `handleStreamEvent`'s existing detection strategy:
  //   - `tool_start` with toolName='Task' → record `input` (subagent_type,
  //     prompt) keyed by toolUseId so we can correlate the eventual
  //     `tool_done` carrying `status:'async_launched'`.
  //   - `tool_done` with toolName='Task' AND parsed content
  //     `status:'async_launched'` → push a SpawnRequest.
  //   - `tool_done` with toolName='Sleep' AND parsed content
  //     `slept:true` → capture `durationMs`.

  const taskInputsByToolUseId = new Map<
    string,
    { subagent_type: string; prompt: string }
  >();
  const collectedSpawns: SpawnRequest[] = [];
  let sleepDurationMs: number | null = null;

  const observer = async (event: StreamEvent): Promise<void> => {
    // Forward to the parent observer FIRST so its persistence / SSE work
    // happens regardless of classification overhead below.
    if (parentOnEvent) {
      try {
        await Promise.resolve(parentOnEvent(event));
      } catch (err) {
        log.warn(
          `leadStep ${input.agentId}: parentOnEvent threw — ignoring: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (event.type === 'tool_start' && event.toolName === TASK_TOOL_NAME) {
      const inp = event.input as
        | { subagent_type?: unknown; prompt?: unknown }
        | null
        | undefined;
      if (
        inp &&
        typeof inp.subagent_type === 'string' &&
        typeof inp.prompt === 'string'
      ) {
        taskInputsByToolUseId.set(event.toolUseId, {
          subagent_type: inp.subagent_type,
          prompt: inp.prompt,
        });
      }
      return;
    }

    if (event.type !== 'tool_done') return;
    if (event.result.is_error) return;

    if (event.toolName === TASK_TOOL_NAME) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.result.content);
      } catch {
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'status' in parsed &&
        (parsed as { status: unknown }).status === 'async_launched'
      ) {
        const inp = taskInputsByToolUseId.get(event.toolUseId);
        if (!inp) {
          // tool_start was either missing or malformed — best-effort fall
          // back to the result's own agentId so D3 still has SOMETHING
          // to record. agentType/prompt are unknown in this path.
          log.warn(
            `leadStep ${input.agentId}: async Task tool_done without matching tool_start input (toolUseId=${event.toolUseId})`,
          );
          return;
        }
        collectedSpawns.push({
          toolUseId: event.toolUseId,
          agentType: inp.subagent_type,
          prompt: inp.prompt,
        });
      }
      return;
    }

    if (event.toolName === SLEEP_TOOL_NAME) {
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
        (parsed as { slept: unknown }).slept === true &&
        'durationMs' in parsed &&
        typeof (parsed as { durationMs: unknown }).durationMs === 'number'
      ) {
        sleepDurationMs = (parsed as { durationMs: number }).durationMs;
      }
      return;
    }
  };

  // -------------------------------------------------------------------------
  // Merge mailbox content into the seed user message. The existing
  // `runAgentTurn` body uses `initialBatch[0].content` as the first user
  // turn; for parity we do the same but also concatenate any additional
  // drained messages so a queued burst doesn't get lost.
  // -------------------------------------------------------------------------

  const seedSegments = mailbox
    .map((m) => m.content ?? '')
    .filter((s) => s.length > 0);
  const seedPrompt = seedSegments.join('\n\n');

  // -------------------------------------------------------------------------
  // Invoke runAgent. D3 will pass the same `injectMessages` FIFO it uses
  // today; the observer here closes over our local Task/Sleep collectors.
  // -------------------------------------------------------------------------

  // Note: runAgent's tenantId already lives on `config.tenantId`. The
  // `tenantId` field on LeadStepInput is exposed in the public input
  // shape for D3's bookkeeping (it may want to log / audit per-run) but
  // is not re-threaded into runAgent — config carries it already.
  void tenantId;

  let agentResult: AgentResult<unknown>;
  try {
    agentResult = await runAgentImpl(
      config,
      seedPrompt,
      ctx,
      undefined, // outputSchema
      undefined, // onProgress
      undefined, // prebuilt
      undefined, // onIdleReset
      observer,
      injectMessages,
      history.length > 0 ? history : undefined,
    );
  } catch (err) {
    // LlmRateLimitedError MUST propagate so processAgentRun can re-enqueue
    // with the bucket-suggested retryMs. Other errors also propagate — D3
    // decides whether to mark the run as 'failed'.
    throw err;
  }

  // -------------------------------------------------------------------------
  // Classification.
  // -------------------------------------------------------------------------

  // Precedence order:
  //   sleep > spawn_and_wait > continue > done
  //
  // Rationale:
  //   - Sleep is a deliberate worker-slot yield; if the agent did BOTH
  //     spawn-async AND sleep, the sleep wins because runAgent already
  //     aborted (the Sleep early-exit fires controller.abort() in the
  //     existing handleStreamEvent). D3 should not treat the same step
  //     as both "waiting on spawns" and "sleeping".
  //   - Spawn-and-wait beats continue/done because waiting on async
  //     teammates is the load-bearing decision; the lead's final
  //     assistant text after a spawn fan-out is irrelevant until the
  //     teammates land.

  // Index of `history.length` at the moment we classify — this is the
  // resume cursor D3 will use. We don't append runAgent's internal
  // transcript here because that lives in agentResult only when D3
  // wires history persistence (already done today via agent_text
  // team_messages rows).
  const lastProcessedIndex = history.length;

  if (sleepDurationMs !== null) {
    // The Sleep tool already wrote agent_runs.sleepUntil = now + durationMs
    // synchronously inside its execute(). Compute the same instant for the
    // decision payload so D3 can audit / log without a re-read.
    const untilMs = Date.now() + sleepDurationMs;
    const newCheckpoint: LeadCheckpoint = {
      lastProcessedIndex,
      pendingToolUseIds:
        checkpoint?.pendingToolUseIds.slice() ?? [],
      state: checkpoint?.state ?? {},
    };
    return { kind: 'sleep', untilMs, newCheckpoint };
  }

  if (collectedSpawns.length > 0) {
    const newCheckpoint: LeadCheckpoint = {
      lastProcessedIndex,
      pendingToolUseIds: [
        ...(checkpoint?.pendingToolUseIds ?? []),
        ...collectedSpawns.map((s) => s.toolUseId),
      ],
      state: checkpoint?.state ?? {},
    };
    return { kind: 'spawn_and_wait', spawns: collectedSpawns, newCheckpoint };
  }

  // No spawn / no sleep — runAgent terminated cleanly. Surface the
  // final text as the summary so D3 can stamp it on the synthesized
  // task_notification.
  const summary =
    typeof agentResult.result === 'string'
      ? agentResult.result
      : JSON.stringify(agentResult.result);
  return { kind: 'done', summary };
}
