/**
 * Conversation history reconstruction for team-run coordinators.
 *
 * Claude's API is stateless: every `/v1/messages` call must carry the
 * full conversation. `team_messages` is our on-disk source of truth.
 * This module walks the rows for a team (or a single conversation in
 * Phase 2) and re-assembles a well-formed `Anthropic.Messages.MessageParam[]`
 * with correct tool_use/tool_result pairing — the exact shape runAgent
 * can prepend to the coordinator's next user prompt.
 *
 * Why not keep a live in-memory coordinator? Because Claude itself
 * doesn't. Prompt caching collapses the cost of re-sending history
 * to ~10% per turn after the first call, and statelessness lets runs
 * crash-and-retry without losing context.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { db as defaultDb, type Database } from '@/lib/db';
import { teamMessages } from '@/lib/db/schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:team-conversation');

/**
 * Default upper bound on total history tokens. Well below Sonnet 4.6's
 * context window — leaves headroom for system, tools, the new user
 * message, and model output. Callers can override when tuning for cost
 * vs continuity.
 */
export const DEFAULT_HISTORY_TOKEN_BUDGET = 50_000;

/**
 * Cheap token estimate. Claude's tokenizer approximates 1 token per
 * ~3.6 chars for English text; we use 4 for a safe underestimate (we
 * want to fit, not overflow). Exact counting is expensive and not
 * needed here — the purpose is a conservative trim, not a billing
 * calculation.
 */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

interface TeamMessageRow {
  id: string;
  teamId: string;
  runId: string | null;
  conversationId: string | null;
  fromMemberId: string | null;
  toMemberId: string | null;
  type: string;
  content: string | null;
  metadata: unknown;
  /**
   * Phase 2b — Anthropic-native `ContentBlockParam[]` when populated.
   * Null for legacy rows; the loader falls back to `normalizeRowContent`
   * to derive blocks from `content` + `metadata` in that case.
   */
  contentBlocks: unknown;
  createdAt: Date;
}

interface ToolCallMetadata {
  toolName?: unknown;
  toolUseId?: unknown;
  input?: unknown;
  /** Set when this message is INTERNAL to a Task-spawned subagent
   *  rather than visible to the coordinator. */
  parentTaskId?: unknown;
}

interface ToolResultMetadata {
  toolName?: unknown;
  toolUseId?: unknown;
  isError?: unknown;
  parentTaskId?: unknown;
}

function asMeta<T>(m: unknown): T {
  return (m ?? {}) as T;
}

/**
 * Drop rows that live INSIDE a Task-spawned subagent's scope. The
 * coordinator's conversation only sees its own `Task` tool_call and the
 * returned tool_result summary — not the subagent's internal x_search
 * / StructuredOutput chatter. Subagent-internal rows carry
 * `metadata.parentTaskId` (see team-run.ts emitToolEvent).
 */
function isCoordinatorScope(row: TeamMessageRow): boolean {
  const meta = asMeta<{ parentTaskId?: unknown }>(row.metadata);
  return meta.parentTaskId === undefined || meta.parentTaskId === null;
}

export interface LoadConversationHistoryOptions {
  /** Max total tokens across the reconstructed history. Default 50_000. */
  tokenBudget?: number;
  /** Scope loader to a single conversation when Phase 2 is wired. */
  conversationId?: string;
  /**
   * Skip messages belonging to this run_id. Typical use: team-run's
   * worker loads history BEFORE calling runAgent, and runAgent uses
   * `run.goal` (the same text already persisted as user_prompt for
   * the fresh run) — without this exclusion the user's new turn
   * shows up twice in the Anthropic payload.
   */
  excludeRunId?: string;
  /** Inject a Database instance for tests. */
  db?: Database;
}

/**
 * Load the coordinator's visible conversation history for a team (or
 * a specific conversation when `conversationId` is supplied) and
 * return it in Anthropic message shape, ready to prepend to a fresh
 * user_prompt.
 *
 * Guarantees:
 *  - Every assistant message with `tool_use` blocks is followed by a
 *    user message containing ALL matching `tool_result` blocks.
 *  - Orphan tool_use blocks (no matching tool_result — e.g. worker
 *    crashed mid-tool) are synthesized with a placeholder error result
 *    so Anthropic's validator accepts the payload.
 *  - History is trimmed from the OLDEST end when the token budget is
 *    exceeded, never from the middle (which would strand tool pairs).
 */
export async function loadConversationHistory(
  teamId: string,
  opts: LoadConversationHistoryOptions = {},
): Promise<Anthropic.Messages.MessageParam[]> {
  const db = opts.db ?? defaultDb;
  const budget = opts.tokenBudget ?? DEFAULT_HISTORY_TOKEN_BUDGET;

  const scopeClause = opts.conversationId
    ? and(
        eq(teamMessages.teamId, teamId),
        eq(teamMessages.conversationId, opts.conversationId),
      )
    : // No conversationId → load everything the team has written that
      // isn't yet assigned to a conversation (legacy rows before the
      // Phase 2 migration). This keeps pre-migration teams working.
      and(
        eq(teamMessages.teamId, teamId),
        isNull(teamMessages.conversationId),
      );

  const whereClause = opts.excludeRunId
    ? and(scopeClause, ne(teamMessages.runId, opts.excludeRunId))
    : scopeClause;

  const rows = (await db
    .select({
      id: teamMessages.id,
      teamId: teamMessages.teamId,
      runId: teamMessages.runId,
      conversationId: teamMessages.conversationId,
      fromMemberId: teamMessages.fromMemberId,
      toMemberId: teamMessages.toMemberId,
      type: teamMessages.type,
      content: teamMessages.content,
      metadata: teamMessages.metadata,
      contentBlocks: teamMessages.contentBlocks,
      createdAt: teamMessages.createdAt,
    })
    .from(teamMessages)
    .where(whereClause)
    .orderBy(asc(teamMessages.createdAt))) as TeamMessageRow[];

  const scoped = rows.filter(isCoordinatorScope);
  const messages = assembleMessages(scoped);
  return trimToBudget(messages, budget);
}

/**
 * Walk rows in chronological order and group consecutive tool
 * interactions into the Anthropic turn shape.
 *
 *   user_prompt  → role:user, text
 *   completion   → role:assistant, text  (flushes any pending assistant)
 *   tool_call    → appends tool_use block to a pending assistant msg
 *   tool_result  → appends tool_result block to a pending user msg
 */
function assembleMessages(
  rows: TeamMessageRow[],
): Anthropic.Messages.MessageParam[] {
  const out: Anthropic.Messages.MessageParam[] = [];

  // Pending blocks waiting to be committed as one message. At any given
  // time at most one of these is non-null.
  let pendingAssistant: Array<
    Anthropic.Messages.TextBlockParam | Anthropic.Messages.ToolUseBlockParam
  > | null = null;
  let pendingUserToolResults: Anthropic.Messages.ToolResultBlockParam[] | null =
    null;
  // tool_use_ids awaiting tool_result — used to synthesize placeholders
  // for crashed-run orphans.
  const pendingToolUseIds = new Set<string>();
  // Every tool_use_id we've emitted into the assembled messages so far.
  // A tool_result whose id isn't in this set has no matching tool_use
  // in the history (e.g. the tool_use row carried `parentTaskId` and
  // was filtered out while its tool_result was recorded without one,
  // or the whole pair predated a budget trim that sliced the tool_use
  // row but not the result). Anthropic's API rejects such rows with
  // `unexpected tool_use_id found in tool_result` — drop them rather
  // than propagate the 400.
  const seenToolUseIds = new Set<string>();

  /**
   * Commit the pending assistant message.
   *
   * `synthesizeOrphans=true` means we're about to start a new turn
   * (user_prompt / completion / end-of-walk) — any tool_use still
   * awaiting a result must be a run crash, so we synthesize an error
   * result to keep the Anthropic payload valid.
   *
   * `synthesizeOrphans=false` means the NEXT row is a tool_result,
   * which is the legitimate pair for (some of) the pending ids —
   * don't synthesize; commit the assistant and let the coming
   * tool_results hydrate pendingUserToolResults.
   */
  const commitAssistant = (synthesizeOrphans: boolean) => {
    if (!pendingAssistant || pendingAssistant.length === 0) return;
    out.push({ role: 'assistant', content: pendingAssistant });
    if (synthesizeOrphans && pendingToolUseIds.size > 0) {
      const synthesized = Array.from(pendingToolUseIds).map(
        (id): Anthropic.Messages.ToolResultBlockParam => ({
          type: 'tool_result',
          tool_use_id: id,
          content:
            '[orphaned tool_use — run crashed before result was recorded]',
          is_error: true,
        }),
      );
      out.push({ role: 'user', content: synthesized });
      pendingToolUseIds.clear();
    }
    pendingAssistant = null;
  };

  const commitUserToolResults = () => {
    if (pendingUserToolResults && pendingUserToolResults.length > 0) {
      out.push({ role: 'user', content: pendingUserToolResults });
      pendingUserToolResults = null;
    }
  };

  for (const row of rows) {
    switch (row.type) {
      case 'user_prompt': {
        // A new user turn closes any pending assistant; any unmatched
        // tool_use on that assistant is a real orphan (the prior turn
        // never got its tool_result), so synthesize.
        commitUserToolResults();
        commitAssistant(true);
        if (row.content) {
          out.push({ role: 'user', content: row.content });
        }
        break;
      }

      case 'completion':
      case 'agent_text': {
        // Flush any lingering tool_result block first — it belongs to
        // the turn BEFORE this assistant completion.
        commitUserToolResults();
        commitAssistant(true);
        if (row.content) {
          // Coordinator's StructuredOutput is persisted as JSON in
          // `content`. Anthropic accepts text-form assistant content;
          // feeding raw JSON is fine — the next coordinator reads it
          // as "here's what I concluded last turn".
          out.push({ role: 'assistant', content: row.content });
        }
        break;
      }

      case 'tool_call': {
        // A tool_call after pending tool_results means a NEW assistant
        // turn is starting — commit the user tool_results block first.
        commitUserToolResults();
        const meta = asMeta<ToolCallMetadata>(row.metadata);
        const toolUseId = typeof meta.toolUseId === 'string' ? meta.toolUseId : null;
        const toolName = typeof meta.toolName === 'string' ? meta.toolName : null;
        if (!toolUseId || !toolName) {
          // Malformed — skip rather than emit an invalid tool_use.
          break;
        }
        if (!pendingAssistant) pendingAssistant = [];
        const input = (meta.input ?? {}) as Record<string, unknown>;
        pendingAssistant.push({
          type: 'tool_use',
          id: toolUseId,
          name: toolName,
          input,
        });
        pendingToolUseIds.add(toolUseId);
        seenToolUseIds.add(toolUseId);
        break;
      }

      case 'tool_result': {
        // Commit the assistant turn that raised these tool_calls —
        // but DO NOT synthesize orphans yet: this row (and possibly
        // the next few) is the real tool_result pairing.
        commitAssistant(false);
        const meta = asMeta<ToolResultMetadata>(row.metadata);
        const toolUseId = typeof meta.toolUseId === 'string' ? meta.toolUseId : null;
        if (!toolUseId) break;
        // Defensive: drop tool_results whose id was never declared by
        // any assistant tool_use in the reconstructed history.
        // Otherwise Anthropic returns
        // `messages.N.content.M: unexpected tool_use_id found in tool_result`.
        if (!seenToolUseIds.has(toolUseId)) break;
        if (!pendingUserToolResults) pendingUserToolResults = [];
        pendingUserToolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: row.content ?? '',
          ...(meta.isError ? { is_error: true } : {}),
        });
        pendingToolUseIds.delete(toolUseId);
        break;
      }

      // Skip types that don't translate to Anthropic message shape:
      // `error`, `thinking` (extended-thinking blocks need special
      // handling we're not enabling yet).
      default:
        break;
    }
  }

  // Final flush — any unmatched tool_use is a genuine orphan.
  commitUserToolResults();
  commitAssistant(true);

  return out;
}

/**
 * Trim the oldest messages off the front until total tokens fit in
 * the budget. Never splits a turn pair — if removing the oldest
 * message leaves a dangling assistant/tool_use without its result,
 * we drop the matching next message too (and repeat).
 */
function trimToBudget(
  messages: Anthropic.Messages.MessageParam[],
  tokenBudget: number,
): Anthropic.Messages.MessageParam[] {
  const working = [...messages];

  while (working.length > 0 && totalTokens(working) > tokenBudget) {
    working.shift();
    normalizeFront(working);
  }

  // Final pass in case we're already under budget but the history
  // starts with something Anthropic rejects — happens when the very
  // first row in the scoped query is an assistant turn (shouldn't in
  // practice, but cheap to guard).
  normalizeFront(working);

  if (working.length < messages.length) {
    log.debug(
      `team-conversation: trimmed ${messages.length - working.length} oldest messages to fit ${tokenBudget}-token budget`,
    );
  }
  return working;
}

/**
 * Drop messages from the front until the history begins with a
 * valid user message. Cases that violate Anthropic's payload shape:
 *   1. First message is an assistant turn — the API requires `user`
 *      first, otherwise the conversation "starts mid-thought".
 *   2. First message is a user turn made entirely of `tool_result`
 *      blocks — its matching assistant `tool_use` was trimmed,
 *      leaving orphaned result ids that the API will reject with
 *      `unexpected tool_use_id found in tool_result`.
 */
function normalizeFront(working: Anthropic.Messages.MessageParam[]): void {
  while (working.length > 0) {
    const first = working[0]!;
    if (first.role === 'assistant') {
      working.shift();
      continue;
    }
    if (first.role === 'user' && isToolResultUserMessage(first)) {
      working.shift();
      continue;
    }
    break;
  }
}

function isToolResultUserMessage(
  msg: Anthropic.Messages.MessageParam,
): boolean {
  if (msg.role !== 'user') return false;
  if (typeof msg.content === 'string') return false;
  return msg.content.some((b) => b.type === 'tool_result');
}

function totalTokens(messages: Anthropic.Messages.MessageParam[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
      continue;
    }
    for (const block of msg.content) {
      if (block.type === 'text') total += estimateTokens(block.text);
      else if (block.type === 'tool_use')
        total += estimateTokens(JSON.stringify(block.input));
      else if (block.type === 'tool_result') {
        if (typeof block.content === 'string') total += estimateTokens(block.content);
        else if (Array.isArray(block.content)) {
          for (const sub of block.content) {
            if (sub.type === 'text') total += estimateTokens(sub.text);
          }
        }
      }
    }
  }
  return total;
}
