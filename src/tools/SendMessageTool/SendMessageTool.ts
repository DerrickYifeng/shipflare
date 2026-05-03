// Replaces engine/tools/SendMessageTool/ (Claude Code).
// CC's transport: tmux splitpane + in-process queue. ShipFlare transport:
// Redis pub/sub to SSE subscribers + durable record in team_messages table.
//
// Spec §5.3 + §9.3. Resolves `to` against `team_members.display_name` OR
// `team_members.id` (uuid-like), INSERTs a team_messages row, publishes to
// `team:${teamId}:messages` for live SSE delivery. Redis failures are
// logged but do NOT fail the tool call — the DB insert is the durable
// record; Redis is only a live-delivery optimization.

import { z } from 'zod';
import { and, eq, gt } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type {
  ToolContext,
  ToolDefinition,
  ValidationResult,
} from '@/core/types';
import { createLogger } from '@/lib/logger';
import { db as defaultDb, type Database } from '@/lib/db';
import { teamMembers, teamMessages } from '@/lib/db/schema';
import { getPubSubPublisher } from '@/lib/redis';
import { wake } from '@/workers/processors/lib/wake';
import { insertPeerDmShadow } from '@/workers/processors/lib/peer-dm-shadow';
import { resolveAgent } from '@/tools/AgentTool/registry';

const log = createLogger('tools:SendMessage');

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const SEND_MESSAGE_TOOL_NAME = 'SendMessage';

/** Redis channel template used by `/api/team/events` SSE consumers. */
export function teamMessagesChannel(teamId: string): string {
  return `team:${teamId}:messages`;
}

/**
 * Redis channel for live-injecting user messages into a running
 * coordinator. `POST /api/team/conversations/:id/messages` publishes a
 * JSON payload `{ content: string }` here when the user sends a
 * message to an active run; the team-run worker's subscriber
 * accumulates them in a FIFO and drains into the conversation at the
 * next turn boundary.
 */
export function teamInjectChannel(teamId: string, runId: string): string {
  return `team:${teamId}:inject:${runId}`;
}

/**
 * Redis channel for user-initiated run cancellation. `/api/team/run/
 * [runId]/cancel` publishes any payload here (content ignored); the
 * worker subscribes for the duration of the run and, on receive, aborts
 * its top-level `AbortController` — that signal flows through runAgent
 * into the Anthropic SDK, which raises `APIUserAbortError` from the
 * stream reader and unwinds the turn loop cleanly.
 */
export function teamCancelChannel(teamId: string, runId: string): string {
  return `team:${teamId}:cancel:${runId}`;
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------
//
// Phase C: 5-variant discriminated union per Agent Teams spec §4.1.
// Backward compat: bare {to, message} (no `type`) is treated as
// `type: 'message'` via preprocessor — preserves the legacy call sites in
// team-run.ts and the API routes. The preprocessor also renames the legacy
// `message` field to the canonical `content` so existing callers don't have
// to change their wire shape.
//
// `task_notification` and `tick` are intentionally NOT in the union — they
// are system-only messageTypes inserted directly by the workers and must
// never be tool-callable.

const messageVariant = z.object({
  type: z.literal('message'),
  /** memberId (uuid-like) OR display_name; scoped to the caller's team. */
  to: z.string().min(1),
  // `content` is the new canonical name; legacy callers used `message` —
  // the preprocessor maps `message` → `content` for back-compat.
  content: z.string().min(1),
  summary: z.string().optional(),
  run_id: z.string().optional(),
});

const broadcastVariant = z
  .object({
    type: z.literal('broadcast'),
    content: z.string().min(1),
    summary: z.string().optional(),
    run_id: z.string().optional(),
  })
  .strict();

const shutdownRequestVariant = z.object({
  type: z.literal('shutdown_request'),
  to: z.string().min(1),
  content: z.string().min(1),
  summary: z.string().optional(),
  run_id: z.string().optional(),
});

const shutdownResponseVariant = z.object({
  type: z.literal('shutdown_response'),
  request_id: z.string().min(1),
  approve: z.boolean(),
  content: z.string().optional(),
  run_id: z.string().optional(),
});

const planApprovalResponseVariant = z.object({
  type: z.literal('plan_approval_response'),
  request_id: z.string().min(1),
  to: z.string().min(1),
  approve: z.boolean(),
  content: z.string().optional(),
  run_id: z.string().optional(),
});

// Preprocessor: inject type='message' for legacy {to, message} callers.
// Also map `message` field → `content` so legacy callers don't break.
export const SendMessageInputSchema = z.preprocess(
  (raw) => {
    if (raw === null || typeof raw !== 'object') return raw;
    const obj = raw as Record<string, unknown>;
    if (obj.type === undefined) {
      // Legacy form: ensure type='message' AND map message→content.
      const next: Record<string, unknown> = { ...obj, type: 'message' };
      if (next.message !== undefined && next.content === undefined) {
        next.content = next.message;
        delete next.message;
      }
      return next;
    }
    return raw;
  },
  z.discriminatedUnion('type', [
    messageVariant,
    broadcastVariant,
    shutdownRequestVariant,
    shutdownResponseVariant,
    planApprovalResponseVariant,
  ]),
);

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface SendMessageResult {
  delivered: true;
  messageId: string;
  /** Resolved member id (uuid of the matched team_members row). */
  toMemberId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A permissive UUID-ish matcher. We only use it to branch between "look up by
// id" and "look up by display_name" — strict format validation happens at the
// DB layer when the row doesn't exist.
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extract teamId / currentMemberId / runId from the ToolContext deps. */
function readTeamContext(ctx: ToolContext): {
  teamId: string;
  currentMemberId: string | null;
  runId: string | null;
  db: Database;
} {
  // `teamId` is required — the runner must always inject it.
  const teamId = ctx.get<string>('teamId');

  // These are optional — allow absence without throwing so SendMessage stays
  // usable outside a run (e.g. a user→member broadcast triggered by the API
  // route before a run exists). A missing value from ctx.get throws, so we
  // catch per-key.
  let currentMemberId: string | null = null;
  try {
    currentMemberId = ctx.get<string>('currentMemberId');
  } catch {
    currentMemberId = null;
  }

  let runId: string | null = null;
  try {
    runId = ctx.get<string>('runId');
  } catch {
    runId = null;
  }

  // Allow tests to inject a mock db via deps; fall back to the app-wide
  // singleton so real runs don't need to plumb it through.
  let database: Database = defaultDb;
  try {
    database = ctx.get<Database>('db');
  } catch {
    // Keep default.
  }

  return { teamId, currentMemberId, runId, db: database };
}

/**
 * Resolve `to` (uuid OR display_name) against team_members, scoped to the
 * caller's team. Returns the member id string; throws on not-found /
 * ambiguous matches so the LLM can self-correct via tool_result.
 */
async function resolveRecipient(
  toRaw: string,
  teamId: string,
  database: Database,
): Promise<string> {
  const needle = toRaw.trim();

  // UUID-like? Try id lookup first (scoped to teamId to prevent cross-team
  // reach-across).
  if (UUID_LIKE.test(needle)) {
    const rows = await database
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(and(eq(teamMembers.id, needle), eq(teamMembers.teamId, teamId)))
      .limit(1);
    if (rows.length === 1) return rows[0].id;
    // Fall through to display_name (accepts the edge case of an agent named
    // with a uuid-shaped display_name).
  }

  const rows = await database
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.displayName, needle),
        eq(teamMembers.teamId, teamId),
      ),
    )
    .limit(2);

  if (rows.length === 0) {
    throw new Error(
      `SendMessage: no team member named "${needle}" in team ${teamId}. ` +
        `Pass either the member's uuid or their exact display_name.`,
    );
  }
  if (rows.length > 1) {
    throw new Error(
      `SendMessage: display_name "${needle}" is ambiguous (multiple matches in team ${teamId}). ` +
        `Use the member's uuid to disambiguate.`,
    );
  }
  return rows[0].id;
}

/**
 * Read the caller's team role from the ToolContext.
 *
 * Phase C: the team-run / agent-run runners inject `callerRole` into the
 * tool deps Map (`'lead' | 'member'`). When the key is absent (legacy call
 * sites that haven't been wired yet), this returns `null` so lead-only
 * checks fail closed — the engine fail-closed pattern requires explicit
 * positive assertion of authority, never inference.
 */
function getCallerRole(ctx: ToolContext): 'lead' | 'member' | null {
  try {
    return ctx.get<'lead' | 'member'>('callerRole');
  } catch {
    return null;
  }
}

/**
 * Count broadcasts sent by `fromMemberId` in the team within the last
 * `windowSeconds`. Used by `validateInput` to enforce the engine PDF's
 * "broadcasting is expensive" rate-limit (1 per turn ≈ 5s).
 *
 * Returns the row count (`> 0` => block). The caller passes its own
 * Database handle so test mocks flow through cleanly.
 */
async function countRecentBroadcasts(
  database: Database,
  teamId: string,
  fromMemberId: string,
  windowSeconds: number,
): Promise<number> {
  const since = new Date(Date.now() - windowSeconds * 1000);
  const rows = await database
    .select({ id: teamMessages.id })
    .from(teamMessages)
    .where(
      and(
        eq(teamMessages.teamId, teamId),
        eq(teamMessages.fromMemberId, fromMemberId),
        eq(teamMessages.messageType, 'broadcast'),
        gt(teamMessages.createdAt, since),
      ),
    )
    .limit(1);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Peer-DM-shadow helpers (Phase C Task 5)
// ---------------------------------------------------------------------------
//
// When teammate→teammate `type:message` is sent, dispatchMessage also emits a
// summary-only shadow row to the lead's mailbox so the lead sees what peers
// are talking about WITHOUT being preemptively woken (engine PDF §3.6.1).
//
// The three helpers below are intentionally fail-safe: if the DB lookup
// returns nothing (or the agentType is missing / unknown), the role/name
// query returns null/fallback and dispatchMessage skips the shadow rather
// than throwing. Phase C MUST NOT regress legacy callers that don't yet
// inject `callerRole` / agentType data.

/**
 * Look up a team member's role by joining `team_members.agent_type` against
 * the AgentDefinition registry. Returns `null` on any failure (member not
 * found, agentType missing, registry lookup error) so the caller can fail
 * safely and skip the shadow rather than break legacy code paths.
 */
async function getRoleOfMember(
  memberId: string,
  database: Database,
): Promise<'lead' | 'member' | null> {
  try {
    const rows = await database
      .select({ agentType: teamMembers.agentType })
      .from(teamMembers)
      .where(eq(teamMembers.id, memberId))
      .limit(1);
    const agentType = rows[0]?.agentType;
    if (!agentType) return null;
    const def = await resolveAgent(agentType);
    return def?.role ?? null;
  } catch {
    return null;
  }
}

/**
 * Look up a team member's display_name. Returns the memberId itself as a
 * fallback so the shadow content always has *something* to show, even when
 * the member row was deleted between resolveRecipient() and now.
 */
async function getMemberName(
  memberId: string,
  database: Database,
): Promise<string> {
  try {
    const rows = await database
      .select({ displayName: teamMembers.displayName })
      .from(teamMembers)
      .where(eq(teamMembers.id, memberId))
      .limit(1);
    return rows[0]?.displayName ?? memberId;
  } catch {
    return memberId;
  }
}

/**
 * Resolve the lead's `agent_runs.id` for this team.
 *
 * Phase B kludge: the team-lead currently runs in the team-run worker
 * without a backing `agent_runs` row, so this returns `null` and
 * `insertPeerDmShadow` short-circuits. Phase E lifts this when team-lead
 * unifies onto the agent-run worker (X model). The signature already takes
 * the live db so the swap is a body-only change.
 *
 * Tests may inject a synthetic `leadAgentId` via the ToolContext to exercise
 * the post-Phase-E path.
 */
async function getLeadAgentId(
  _teamId: string,
  _database: Database,
): Promise<string | null> {
  // Phase B: lead has no agent_runs row → return null. Phase E will issue
  // `SELECT id FROM agent_runs WHERE team_id=$1 AND role='lead' LIMIT 1`
  // (or equivalent) here.
  return null;
}

async function publishToRedis(
  teamId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const pub = getPubSubPublisher();
    await pub.publish(teamMessagesChannel(teamId), JSON.stringify(payload));
  } catch (err) {
    // Redis is a live-delivery optimization, not the durable record. Warn
    // but do not fail the tool call — the DB insert already happened.
    log.warn(
      `Redis publish to team:${teamId}:messages failed; SSE subscribers will miss this message live: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

// ---------------------------------------------------------------------------
// Variant dispatchers (Phase C Task 2)
// ---------------------------------------------------------------------------
//
// Each dispatcher: (1) resolves recipient(s) where applicable, (2) inserts
// the team_messages row(s) with the variant-specific shape, (3) optionally
// calls wake() on the target so it processes the request promptly,
// (4) publishes to Redis for live SSE delivery, (5) returns SendMessageResult.

interface DispatchDeps {
  teamId: string;
  currentMemberId: string | null;
  runId: string | null;
  db: Database;
  /**
   * Phase C Task 5: needed by `dispatchMessage` to determine fromRole +
   * (eventually) read a synthetic leadAgentId injected by tests / by Phase E
   * runners. Other dispatchers ignore this field.
   */
  ctx: ToolContext;
}

async function dispatchMessage(
  input: Extract<SendMessageInput, { type: 'message' }>,
  deps: DispatchDeps,
): Promise<SendMessageResult> {
  const { teamId, currentMemberId, runId, db, ctx } = deps;
  const toMemberId = await resolveRecipient(input.to, teamId, db);
  const effectiveRunId = input.run_id ?? runId ?? null;
  const messageId = crypto.randomUUID();
  const createdAt = new Date();

  await db.insert(teamMessages).values({
    id: messageId,
    runId: effectiveRunId,
    teamId,
    fromMemberId: currentMemberId,
    toMemberId,
    type: 'agent_text',
    messageType: 'message',
    content: input.content,
    summary: input.summary ?? null,
    metadata: null,
    createdAt,
  });

  await publishToRedis(teamId, {
    messageId,
    runId: effectiveRunId,
    from: currentMemberId,
    to: toMemberId,
    content: input.content,
    createdAt: createdAt.toISOString(),
    type: 'agent_text',
    messageType: 'message',
  });

  // Phase C Task 5 — peer-DM visibility shadow.
  // When BOTH ends are teammates (NOT lead), insert a summary-only shadow
  // row to the lead's mailbox so the lead sees what peers are talking about
  // without being woken (engine PDF §3.6.1 channel ③). All lookups are
  // fail-safe: missing role data, missing leadAgentId, or any DB error
  // simply skips the shadow rather than break the primary message dispatch.
  await maybeInsertPeerDmShadow({
    input,
    teamId,
    currentMemberId,
    toMemberId,
    db,
    ctx,
  });

  return { delivered: true, messageId, toMemberId };
}

/**
 * Conditionally insert the peer-DM shadow. Extracted from `dispatchMessage`
 * so the (already long) main dispatcher stays readable. The function never
 * throws — any error inside is logged at warn level and swallowed; the
 * primary message has already been durably persisted by the caller.
 */
async function maybeInsertPeerDmShadow(args: {
  input: Extract<SendMessageInput, { type: 'message' }>;
  teamId: string;
  currentMemberId: string | null;
  toMemberId: string;
  db: Database;
  ctx: ToolContext;
}): Promise<void> {
  const { input, teamId, currentMemberId, toMemberId, db, ctx } = args;

  // 1. Sender role: trust callerRole when injected by the runner; otherwise
  //    fall back to inferring from the sender's agentType. If neither is
  //    available, fromRole is null → skip shadow (fail-closed for legacy).
  let fromRole: 'lead' | 'member' | null = getCallerRole(ctx);
  if (fromRole === null && currentMemberId !== null) {
    fromRole = await getRoleOfMember(currentMemberId, db);
  }
  if (fromRole !== 'member') return;

  // 2. Recipient role: must also be 'member'. Lead recipients are already
  //    the direct recipient — shadowing would be redundant.
  const toRole = await getRoleOfMember(toMemberId, db);
  if (toRole !== 'member') return;

  // 3. Resolve the lead's agent_runs.id. Tests inject `leadAgentId` via the
  //    ToolContext to exercise the post-Phase-E path; production reads from
  //    `getLeadAgentId(teamId, db)` which currently returns null (Phase B).
  let leadAgentId: string | null = null;
  try {
    leadAgentId = ctx.get<string | null>('leadAgentId');
  } catch {
    leadAgentId = null;
  }
  if (leadAgentId === null) {
    leadAgentId = await getLeadAgentId(teamId, db);
  }

  // 4. Resolve display names for the <peer-dm> attributes. Names are best-
  //    effort: if the row vanished mid-flight, we fall back to the memberId
  //    so the shadow still carries useful provenance.
  const fromName = currentMemberId
    ? await getMemberName(currentMemberId, db)
    : 'unknown';
  const toName = await getMemberName(toMemberId, db);

  try {
    await insertPeerDmShadow({
      teamId,
      leadAgentId,
      fromName,
      toName,
      summary: input.summary ?? input.content.slice(0, 80),
      db,
    });
  } catch (err) {
    // Shadow is a transparency optimization, not a durable contract.
    log.warn(
      `peer-DM shadow insert failed (primary message already persisted): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function dispatchBroadcast(
  input: Extract<SendMessageInput, { type: 'broadcast' }>,
  deps: DispatchDeps,
): Promise<SendMessageResult> {
  const { teamId, currentMemberId, runId, db } = deps;
  const effectiveRunId = input.run_id ?? runId ?? null;
  const createdAt = new Date();

  // Fan out to every member of the current team except the sender.
  // Sender exclusion is applied client-side after the SELECT — using a
  // single `eq(teamId)` constraint keeps the query trivially indexed and
  // avoids reasoning about NULL semantics when `currentMemberId` is null
  // (e.g. user-initiated broadcasts via the API route).
  const allMembers = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  const recipients = allMembers.filter((m) => m.id !== currentMemberId);

  if (recipients.length === 0) {
    throw new Error(
      `SendMessage broadcast: no other members in team ${teamId} to broadcast to.`,
    );
  }

  const insertedIds: string[] = [];
  for (const recipient of recipients) {
    const messageId = crypto.randomUUID();
    insertedIds.push(messageId);
    await db.insert(teamMessages).values({
      id: messageId,
      runId: effectiveRunId,
      teamId,
      fromMemberId: currentMemberId,
      toMemberId: recipient.id,
      type: 'agent_text',
      messageType: 'broadcast',
      content: input.content,
      summary: input.summary ?? null,
      metadata: null,
      createdAt,
    });
  }

  // One publish per broadcast (not per recipient) — SSE subscribers can
  // dispatch to all recipient panels from the single fan-out event.
  await publishToRedis(teamId, {
    messageIds: insertedIds,
    runId: effectiveRunId,
    from: currentMemberId,
    content: input.content,
    createdAt: createdAt.toISOString(),
    type: 'agent_text',
    messageType: 'broadcast',
  });

  // Return the first inserted id + first recipient for compat with the
  // SendMessageResult shape (broadcasts have no single recipient).
  return {
    delivered: true,
    messageId: insertedIds[0],
    toMemberId: recipients[0].id,
  };
}

async function dispatchShutdownRequest(
  input: Extract<SendMessageInput, { type: 'shutdown_request' }>,
  deps: DispatchDeps,
): Promise<SendMessageResult> {
  const { teamId, currentMemberId, runId, db } = deps;
  const toMemberId = await resolveRecipient(input.to, teamId, db);
  const effectiveRunId = input.run_id ?? runId ?? null;
  const messageId = crypto.randomUUID();
  const createdAt = new Date();

  await db.insert(teamMessages).values({
    id: messageId,
    runId: effectiveRunId,
    teamId,
    fromMemberId: currentMemberId,
    toMemberId,
    type: 'user_prompt',
    messageType: 'shutdown_request',
    content: input.content,
    summary: input.summary ?? null,
    metadata: null,
    createdAt,
  });

  // Wake the target so it drains the request at its next idle turn.
  // Phase C kludge: `toMemberId` is treated as the wake target. Phase E will
  // route via agent_runs.id when the unified team-run / agent-run model lands.
  await wake(toMemberId);

  await publishToRedis(teamId, {
    messageId,
    runId: effectiveRunId,
    from: currentMemberId,
    to: toMemberId,
    content: input.content,
    createdAt: createdAt.toISOString(),
    type: 'user_prompt',
    messageType: 'shutdown_request',
  });

  return { delivered: true, messageId, toMemberId };
}

async function dispatchShutdownResponse(
  input: Extract<SendMessageInput, { type: 'shutdown_response' }>,
  deps: DispatchDeps,
): Promise<SendMessageResult> {
  const { teamId, currentMemberId, runId, db } = deps;
  const effectiveRunId = input.run_id ?? runId ?? null;
  const messageId = crypto.randomUUID();
  const createdAt = new Date();

  // shutdown_response has no `to` — it routes via the request_id chain.
  // We leave toMemberId NULL; the conversation thread is recovered by
  // following repliesToId back to the originating shutdown_request.
  const content =
    input.content ?? (input.approve ? 'shutdown approved' : 'shutdown declined');

  await db.insert(teamMessages).values({
    id: messageId,
    runId: effectiveRunId,
    teamId,
    fromMemberId: currentMemberId,
    toMemberId: null,
    type: 'agent_text',
    messageType: 'shutdown_response',
    content,
    summary: null,
    metadata: { approve: input.approve },
    repliesToId: input.request_id,
    createdAt,
  });

  await publishToRedis(teamId, {
    messageId,
    runId: effectiveRunId,
    from: currentMemberId,
    repliesToId: input.request_id,
    approve: input.approve,
    content,
    createdAt: createdAt.toISOString(),
    type: 'agent_text',
    messageType: 'shutdown_response',
  });

  // toMemberId is null for shutdown_response (lead picks up on its next
  // natural turn); fall back to empty string in the result to satisfy the
  // SendMessageResult shape without inventing a fake recipient.
  return { delivered: true, messageId, toMemberId: '' };
}

async function dispatchPlanApprovalResponse(
  input: Extract<SendMessageInput, { type: 'plan_approval_response' }>,
  deps: DispatchDeps,
): Promise<SendMessageResult> {
  const { teamId, currentMemberId, runId, db } = deps;
  const toMemberId = await resolveRecipient(input.to, teamId, db);
  const effectiveRunId = input.run_id ?? runId ?? null;
  const messageId = crypto.randomUUID();
  const createdAt = new Date();
  const content =
    input.content ?? (input.approve ? 'plan approved' : 'plan rejected');

  await db.insert(teamMessages).values({
    id: messageId,
    runId: effectiveRunId,
    teamId,
    fromMemberId: currentMemberId,
    toMemberId,
    type: 'user_prompt',
    messageType: 'plan_approval_response',
    content,
    summary: null,
    metadata: { approve: input.approve },
    repliesToId: input.request_id,
    createdAt,
  });

  // Wake the teammate so it resumes its plan promptly on approval/rejection.
  await wake(toMemberId);

  await publishToRedis(teamId, {
    messageId,
    runId: effectiveRunId,
    from: currentMemberId,
    to: toMemberId,
    repliesToId: input.request_id,
    approve: input.approve,
    content,
    createdAt: createdAt.toISOString(),
    type: 'user_prompt',
    messageType: 'plan_approval_response',
  });

  return { delivered: true, messageId, toMemberId };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const sendMessageTool: ToolDefinition<
  SendMessageInput,
  SendMessageResult
> = buildTool({
  name: SEND_MESSAGE_TOOL_NAME,
  description:
    'Send a message from the current team member to another member. ' +
    'Target either by `display_name` (exact match) or by member uuid. ' +
    'The message is durably stored in team_messages and published to the ' +
    'team\'s live event channel so the UI updates in real time.',
  // `z.preprocess(...)` returns a `ZodEffects` whose declared input type is
  // `unknown` (the preprocessor accepts any raw payload). buildTool expects
  // `z.ZodType<TInput>` with input = output, so we cast to the post-process
  // shape. Runtime parsing still goes through the preprocessor — only the
  // compile-time generic is being aligned.
  inputSchema: SendMessageInputSchema as unknown as z.ZodType<SendMessageInput>,
  isConcurrencySafe: true,
  // INSERTs a row + PUBLISHes — unambiguously side-effecting.
  isReadOnly: false,
  // Phase C Task 3: engine fail-closed runtime validation. Two architectural
  // rules that the static zod schema cannot express:
  //   1. plan_approval_response is lead-only — only the team-lead can approve
  //      or reject teammate-submitted plans (engine PDF §2.4).
  //   2. broadcast is rate-limited to 1 per assistant turn (~5s window) per
  //      sender — broadcasts fan out to every teammate, so the engine prompt
  //      explicitly warns "broadcasting is expensive". Best-effort enforced
  //      by a SELECT against team_messages within the window.
  // Other variants pass through untouched.
  async validateInput(input, ctx): Promise<ValidationResult> {
    if (input.type === 'plan_approval_response') {
      const role = getCallerRole(ctx);
      if (role !== 'lead') {
        return {
          result: false,
          errorCode: 403,
          message:
            'plan_approval_response is restricted to team-lead. ' +
            'Only the lead can approve / reject teammate-submitted plans.',
        };
      }
    }

    if (input.type === 'broadcast') {
      const { teamId, currentMemberId, db } = readTeamContext(ctx);
      if (currentMemberId) {
        const recent = await countRecentBroadcasts(
          db,
          teamId,
          currentMemberId,
          5,
        );
        if (recent > 0) {
          return {
            result: false,
            errorCode: 429,
            message:
              'broadcast is rate-limited to 1 per turn / 5 seconds. ' +
              'Use type:message (DM) for follow-up messages to a specific teammate.',
          };
        }
      }
    }

    return { result: true };
  },
  async execute(input, ctx): Promise<SendMessageResult> {
    // Phase C Task 2: dispatch by variant. Each variant inserts a different
    // team_messages shape (messageType column distinguishes them; the
    // legacy `type` column keeps its LLM-flow meaning). shutdown_request +
    // plan_approval_response also wake() the recipient.
    // Phase C Task 5: dispatchMessage additionally reads role / leadAgentId
    // from the ctx, so we thread it through DispatchDeps.
    const deps: DispatchDeps = { ...readTeamContext(ctx), ctx };

    switch (input.type) {
      case 'message':
        return dispatchMessage(input, deps);
      case 'broadcast':
        return dispatchBroadcast(input, deps);
      case 'shutdown_request':
        return dispatchShutdownRequest(input, deps);
      case 'shutdown_response':
        return dispatchShutdownResponse(input, deps);
      case 'plan_approval_response':
        return dispatchPlanApprovalResponse(input, deps);
    }
  },
});
