// Phase D Task D2 — pure decision boundary for the lead's per-turn loop.
//
// `leadStep` invokes `runAgent` (the existing multi-turn LLM loop) and
// classifies what happened into one of four discriminated outcomes:
//
//   - 'spurious_wake'   — empty mailbox + non-empty history. No new
//                         work to do. runAgent is NOT called (would
//                         otherwise push an empty user message and
//                         trip Anthropic's cache_control-on-empty-text
//                         rejection — same bug fixed in
//                         `agent-run.ts:820-895` on 2026-05-12).
//                         D3 should put the agent back to sleep with
//                         no status writes and no API spend.
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
// Public types — match the D2 plan contract.
// ---------------------------------------------------------------------------

export interface LeadStepInput {
  agentId: string;
  /**
   * Prior conversation history (Anthropic MessageParam[]) — the caller
   * has already replayed `team_messages` rows up to the checkpoint
   * cursor. leadStep passes this through to runAgent's `priorMessages`
   * unchanged. Empty means "fresh spawn — no transcript yet".
   */
  history: Anthropic.Messages.MessageParam[];
  /**
   * Newly-drained mailbox messages addressed to this agent_run. The
   * caller is responsible for draining `team_messages` via
   * `drainMailbox`; leadStep only consumes `mailbox[0].content` as the
   * seed user message handed to runAgent. Mailbox messages 1..N are NOT
   * consumed by leadStep — the caller MUST re-inject them via the
   * existing `pendingInjections` mechanism (the D3 caller's
   * `injectMessages` callback) so they reach the agent at the next
   * idle-turn boundary. Mirrors today's `agent-run.ts:824` behavior.
   */
  mailbox: DrainedMessage[];
  checkpoint: LeadCheckpoint | null;
  tenantId: string;
}

export interface SpawnRequest {
  toolUseId: string;
  agentType: string;
  prompt: string;
  /**
   * `agent_runs.id` of the teammate the Task tool already INSERTed. The
   * Task tool's async path (`launchAsyncTeammate` in AgentTool.ts) inserts
   * the row + initial mailbox message + wake() BEFORE returning its
   * `tool_done` result, so by the time D3 sees this SpawnRequest the
   * teammate row already exists in `agent_runs`. D3 reads `spawnedAgentId`
   * to populate the lead's `waiting_for` array — no second INSERT needed
   * here (mirrors the engine PDF §3.5 "spawn is idempotent" invariant).
   *
   * Optional because a malformed tool_done payload (e.g. older clients,
   * truncated JSON) may not surface the agentId; D3 warns and skips that
   * child's entry rather than throwing.
   */
  spawnedAgentId?: string;
}

/**
 * Usage envelope surfaced on a clean `done` decision so D3's apply-block
 * can stamp `agent_runs.total_tokens` / `tool_uses` and forward the same
 * counters into the synthesized `task_notification`. Without these
 * fields, the durable path would silently regress billing /
 * observability reads on `agent_runs` (the legacy body summed the four
 * Anthropic token buckets off `result.usage`). Optional because rare
 * call paths (test stubs faking an AgentResult without usage) may not
 * produce a real envelope; D3 falls back to 0.
 */
export interface DoneUsage {
  totalTokens: number;
  toolUses: number;
}

export type LeadStepDecision =
  | { kind: 'spurious_wake' }
  | {
      kind: 'spawn_and_wait';
      spawns: SpawnRequest[];
      newCheckpoint: LeadCheckpoint;
    }
  | { kind: 'sleep'; untilMs: number; newCheckpoint: LeadCheckpoint }
  | { kind: 'done'; summary: string; usage?: DoneUsage };

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
  // Spurious-wake guard. Mirrors `agent-run.ts:820-895` (the 2026-05-12
  // fix). When the mailbox is empty AND we have prior history, there's
  // no new user input — pushing the empty string into runAgent's
  // `userMessage` would land as `{role:'user', content:''}` in the
  // conversation, then `addMessageCacheBreakpoint` would mark the empty
  // text block with `cache_control:ephemeral`, and Anthropic rejects
  // with `messages.N.content.0.text: cache_control cannot be set for
  // empty text blocks`.
  //
  // Returning `spurious_wake` BEFORE invoking runAgent burns zero API
  // spend; D3 puts the agent back to sleep with no checkpoint mutation
  // and no terminal status write, awaiting the next genuine wake.
  // -------------------------------------------------------------------------

  const firstMailContent = mailbox[0]?.content ?? '';
  if (firstMailContent.length === 0 && history.length > 0) {
    log.info(
      `leadStep ${input.agentId}: spurious wake (empty mailbox + ${history.length} priorMessages) — returning to sleep without API call`,
    );
    return { kind: 'spurious_wake' };
  }

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
        // The Task tool's async path stamps the freshly-inserted teammate's
        // `agent_runs.id` onto its result envelope (see
        // `launchAsyncTeammate` return shape in
        // `src/tools/AgentTool/AgentTool.ts:349-356`). D3's
        // `spawn_and_wait` branch needs this id to populate the lead's
        // `agent_runs.waiting_for` array. Best-effort: a malformed payload
        // leaves it undefined and D3 falls back to skipping that child's
        // waiting_for entry.
        const spawnedAgentId =
          'agentId' in parsed &&
          typeof (parsed as { agentId: unknown }).agentId === 'string'
            ? (parsed as { agentId: string }).agentId
            : undefined;
        collectedSpawns.push({
          toolUseId: event.toolUseId,
          agentType: inp.subagent_type,
          prompt: inp.prompt,
          spawnedAgentId,
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
  // Seed user message: first mailbox entry only. Additional mailbox
  // messages (mailbox[1..N]) are NOT folded into the seed — the caller's
  // existing `pendingInjections` drain re-injects them at the next
  // idle-turn boundary inside runAgent (see `injectMessages` callback
  // in agent-run.ts:1388-1391). Mirrors today's `initialBatch[0].content`
  // behavior at agent-run.ts:824, preventing double-injection.
  // -------------------------------------------------------------------------

  const seedPrompt = firstMailContent;

  // -------------------------------------------------------------------------
  // Invoke runAgent. D3 will pass the same `injectMessages` FIFO it uses
  // today; the observer here closes over our local Task/Sleep collectors.
  // -------------------------------------------------------------------------

  // Note: runAgent's tenantId already lives on `config.tenantId`. The
  // `tenantId` field on LeadStepInput is exposed in the public input
  // shape for D3's bookkeeping (it may want to log / audit per-run) but
  // is not re-threaded into runAgent — config carries it already.
  void tenantId;

  const agentResult: AgentResult<unknown> = await runAgentImpl(
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
  // LlmRateLimitedError and any other throws propagate untouched — D3
  // (and outer processAgentRun) decide whether to re-enqueue or fail.

  // -------------------------------------------------------------------------
  // Classification.
  // -------------------------------------------------------------------------

  // Precedence order:
  //   sleep > spawn_and_wait > done
  //
  // Rationale:
  //   - Sleep is a deliberate worker-slot yield; if the agent did BOTH
  //     spawn-async AND sleep, the sleep wins because runAgent already
  //     aborted (the Sleep early-exit fires controller.abort() in the
  //     existing handleStreamEvent). D3 should not treat the same step
  //     as both "waiting on spawns" and "sleeping".
  //   - Spawn-and-wait beats done because waiting on async teammates is
  //     the load-bearing decision; the lead's final assistant text after
  //     a spawn fan-out is irrelevant until the teammates land.

  // `lastProcessedIndex` records the entry-time history length. D3 is
  // responsible for advancing this cursor on the durable side as it
  // persists new assistant_text rows to `team_messages` (the existing
  // pattern from agent-run.ts:1046-1158). See LeadCheckpoint JSDoc in
  // src/lib/db/schema/team.ts for the ownership contract.
  const lastProcessedIndex = history.length;

  if (sleepDurationMs !== null) {
    // The Sleep tool already wrote agent_runs.sleepUntil = now + durationMs
    // synchronously inside its execute(). Compute the same instant for the
    // decision payload so D3 can audit / log without a re-read.
    const untilMs = Date.now() + sleepDurationMs;
    const newCheckpoint: LeadCheckpoint = {
      lastProcessedIndex,
      pendingToolUseIds: checkpoint?.pendingToolUseIds.slice() ?? [],
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
  // task_notification. Also surface the token / turn counters so D3
  // can stamp `agent_runs.total_tokens` / `tool_uses` (mirrors the
  // legacy body's `result.usage` sum at agent-run.ts:1506-1510).
  const summary =
    typeof agentResult.result === 'string'
      ? agentResult.result
      : JSON.stringify(agentResult.result);
  const usage: DoneUsage | undefined = agentResult.usage
    ? {
        totalTokens:
          agentResult.usage.inputTokens +
          agentResult.usage.outputTokens +
          agentResult.usage.cacheReadTokens +
          agentResult.usage.cacheWriteTokens,
        // `UsageSummary.turns` is the closest proxy for "tool uses" in
        // the current schema — the engine doesn't yet separate tool
        // invocations from LLM turns. Match the legacy body which also
        // wrote 0 to `tool_uses` (left as 0 until per-turn stream
        // metrics land); using `turns` is a net improvement.
        toolUses: agentResult.usage.turns ?? 0,
      }
    : undefined;
  return { kind: 'done', summary, usage };
}
