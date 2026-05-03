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
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type {
  ToolContext,
  ToolDefinition,
  ValidationResult,
} from '@/core/types';
import { createLogger } from '@/lib/logger';
import { db as defaultDb, type Database } from '@/lib/db';
import { agentRuns, teamMembers, teamMessages } from '@/lib/db/schema';
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
// Input schema — engine-style flat-top + nested-union design
// ---------------------------------------------------------------------------
//
// Top-level is a flat object `{to, summary?, message, run_id?}` that maps
// directly to Anthropic's tool input_schema grammar (no top-level anyOf).
// `message` is `string | StructuredMessage` — the nested union is allowed
// inside a property even though Anthropic rejects it at the top level.
//
// Routing rules:
// - Broadcast is signalled by `to: "*"` (NOT a separate variant).
// - Plain DM/broadcast: `message` is a string.
// - Protocol responses (shutdown_request, shutdown_response,
//   plan_approval_response): `message` is a discriminated-union object.
//
// `task_notification` and `tick` are intentionally NOT in the union — they
// are system-only messageTypes inserted directly by the workers and must
// never be tool-callable.

const StructuredMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('shutdown_request'),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('shutdown_response'),
    request_id: z.string().min(1),
    approve: z.boolean(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('plan_approval_response'),
    request_id: z.string().min(1),
    approve: z.boolean(),
    feedback: z.string().optional(),
  }),
]);

export const SendMessageInputSchema = z.object({
  to: z
    .string()
    .min(1)
    .describe(
      'Recipient: teammate name, agent_runs.id, OR "*" for broadcast to all teammates. ' +
        'Broadcast is expensive (linear in team size) — use only when everyone needs it.',
    ),
  summary: z
    .string()
    .optional()
    .describe(
      '5-10 word UI preview shown to the team-lead via peer-DM-visibility. ' +
        'Required when message is a plain string DM.',
    ),
  message: z
    .union([
      z.string().min(1).describe('Plain text message content (DM or broadcast)'),
      StructuredMessage,
    ])
    .describe(
      'Either a plain string (regular DM/broadcast) OR a structured protocol response. ' +
        'Use structured form to reply to a shutdown_request or plan_approval_request.',
    ),
  run_id: z.string().optional(),
});

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;
export type StructuredMessageInput = z.infer<typeof StructuredMessage>;

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
 * The team-run / agent-run runners inject `callerRole` into the tool deps
 * Map (`'lead' | 'member'`). When the key is absent (legacy call sites),
 * this returns `null` so lead-only checks fail closed — the engine
 * fail-closed pattern requires explicit positive assertion of authority,
 * never inference.
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
// Peer-DM-shadow helpers
// ---------------------------------------------------------------------------
//
// When teammate→teammate plain-string DM is sent, dispatchMessage also emits
// a summary-only shadow row to the lead's mailbox so the lead sees what
// peers are talking about WITHOUT being preemptively woken (engine PDF
// §3.6.1).
//
// The three helpers below are intentionally fail-safe: if the DB lookup
// returns nothing (or the agentType is missing / unknown), the role/name
// query returns null/fallback and dispatchMessage skips the shadow rather
// than throwing.

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

/**
 * Resolve the most recently active `agent_runs.id` for a member that is
 * still addressable (status='running' or 'sleeping'). Returns `null` when
 * the member has no live run — callers should treat that as "nothing to
 * deliver to right now" and surface a clear error to the LLM.
 *
 * shutdown_request and plan_approval_response previously passed
 * `toMemberId` directly to `wake()`, which is the wrong address —
 * `wake()` enqueues against `agent_runs.id`. This helper lets the
 * dispatchers route via the correct identifier so the BullMQ payload
 * lands on the running agent loop, not a no-op.
 *
 * `ORDER BY lastActiveAt DESC LIMIT 1` mirrors the team-lead reconnect
 * heuristic: if the same member somehow has multiple live rows (race
 * during reconcile), we wake the one that ticked most recently.
 */
async function resolveTargetAgentRun(
  toMemberId: string,
  database: Database,
): Promise<string | null> {
  const rows = await database
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.memberId, toMemberId),
        inArray(agentRuns.status, ['running', 'sleeping']),
      ),
    )
    .orderBy(desc(agentRuns.lastActiveAt))
    .limit(1);
  return rows[0]?.id ?? null;
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
// Variant dispatchers
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
   * Needed by `dispatchMessage` to determine fromRole + (eventually) read a
   * synthetic leadAgentId injected by tests / by Phase E runners. Other
   * dispatchers ignore this field.
   */
  ctx: ToolContext;
}

async function dispatchMessage(
  input: SendMessageInput & { message: string },
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
    content: input.message,
    summary: input.summary ?? null,
    metadata: null,
    createdAt,
  });

  await publishToRedis(teamId, {
    messageId,
    runId: effectiveRunId,
    from: currentMemberId,
    to: toMemberId,
    content: input.message,
    createdAt: createdAt.toISOString(),
    type: 'agent_text',
    messageType: 'message',
  });

  // Peer-DM visibility shadow.
  // When BOTH ends are teammates (NOT lead), insert a summary-only shadow
  // row to the lead's mailbox so the lead sees what peers are talking about
  // without being woken (engine PDF §3.6.1 channel ③). All lookups are
  // fail-safe: missing role data, missing leadAgentId, or any DB error
  // simply skips the shadow rather than break the primary message dispatch.
  await maybeInsertPeerDmShadow({
    content: input.message,
    summary: input.summary,
    teamId,
    currentMemberId,
    toMemberId,
    db,
    ctx,
  });

  // Wake the recipient if it's sleeping. Now that teammates can yield their
  // BullMQ slot via Sleep, a plain DM must also resume them — otherwise the
  // message would sit in the mailbox until the next reconcile-mailbox tick
  // (~60s) or the sleep timer fires. We resolve recipients by
  // team_members.id; we look up the corresponding agent_runs row for that
  // member and wake by its agent_runs.id (the wake helper's actual
  // address). If the recipient has no agent_runs row OR it's already
  // running, this query returns nothing and wake is a no-op.
  const sleeping = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.memberId, toMemberId),
        eq(agentRuns.status, 'sleeping'),
      ),
    )
    .limit(1);
  if (sleeping.length > 0) {
    await wake(sleeping[0].id);
  }

  return { delivered: true, messageId, toMemberId };
}

/**
 * Conditionally insert the peer-DM shadow. Extracted from `dispatchMessage`
 * so the (already long) main dispatcher stays readable. The function never
 * throws — any error inside is logged at warn level and swallowed; the
 * primary message has already been durably persisted by the caller.
 */
async function maybeInsertPeerDmShadow(args: {
  content: string;
  summary: string | undefined;
  teamId: string;
  currentMemberId: string | null;
  toMemberId: string;
  db: Database;
  ctx: ToolContext;
}): Promise<void> {
  const { content, summary, teamId, currentMemberId, toMemberId, db, ctx } =
    args;

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
      summary: summary ?? content.slice(0, 80),
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
  input: SendMessageInput & { message: string },
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
      content: input.message,
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
    content: input.message,
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
  input: SendMessageInput,
  structured: Extract<StructuredMessageInput, { type: 'shutdown_request' }>,
  deps: DispatchDeps,
): Promise<SendMessageResult> {
  const { teamId, currentMemberId, runId, db } = deps;
  const toMemberId = await resolveRecipient(input.to, teamId, db);

  // Route by agent_runs.id, not team_members.id. wake() enqueues against
  // agent_runs.id; passing the static member id silently no-ops because no
  // BullMQ job binds to it. Inserting `toAgentId` here also lets the
  // recipient's mailbox-drain pick the row up via
  // `idx_team_messages_to_undelivered`.
  const targetAgentId = await resolveTargetAgentRun(toMemberId, db);
  if (targetAgentId === null) {
    throw new Error(
      `SendMessage shutdown_request: no active agent_run for member ${toMemberId}. ` +
        `Recipient must be running or sleeping to receive shutdown requests.`,
    );
  }

  const effectiveRunId = input.run_id ?? runId ?? null;
  const messageId = crypto.randomUUID();
  const createdAt = new Date();
  const content = structured.reason ?? 'shutdown requested';

  await db.insert(teamMessages).values({
    id: messageId,
    runId: effectiveRunId,
    teamId,
    fromMemberId: currentMemberId,
    toMemberId,
    toAgentId: targetAgentId,
    type: 'user_prompt',
    messageType: 'shutdown_request',
    content,
    summary: input.summary ?? null,
    metadata: null,
    createdAt,
  });

  // Wake the target so it drains the request at its next idle turn.
  await wake(targetAgentId);

  await publishToRedis(teamId, {
    messageId,
    runId: effectiveRunId,
    from: currentMemberId,
    to: toMemberId,
    content,
    createdAt: createdAt.toISOString(),
    type: 'user_prompt',
    messageType: 'shutdown_request',
  });

  return { delivered: true, messageId, toMemberId };
}

async function dispatchShutdownResponse(
  input: SendMessageInput,
  structured: Extract<StructuredMessageInput, { type: 'shutdown_response' }>,
  deps: DispatchDeps,
): Promise<SendMessageResult> {
  const { teamId, currentMemberId, runId, db } = deps;
  const effectiveRunId = input.run_id ?? runId ?? null;
  const messageId = crypto.randomUUID();
  const createdAt = new Date();

  // shutdown_response routes via the request_id chain. We leave toMemberId
  // NULL; the conversation thread is recovered by following repliesToId
  // back to the originating shutdown_request.
  const content =
    structured.reason ??
    (structured.approve ? 'shutdown approved' : 'shutdown declined');

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
    metadata: { approve: structured.approve },
    repliesToId: structured.request_id,
    createdAt,
  });

  await publishToRedis(teamId, {
    messageId,
    runId: effectiveRunId,
    from: currentMemberId,
    repliesToId: structured.request_id,
    approve: structured.approve,
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
  input: SendMessageInput,
  structured: Extract<
    StructuredMessageInput,
    { type: 'plan_approval_response' }
  >,
  deps: DispatchDeps,
): Promise<SendMessageResult> {
  const { teamId, currentMemberId, runId, db } = deps;
  const toMemberId = await resolveRecipient(input.to, teamId, db);

  // Route by agent_runs.id, not team_members.id. See the matching block in
  // dispatchShutdownRequest for the full rationale.
  const targetAgentId = await resolveTargetAgentRun(toMemberId, db);
  if (targetAgentId === null) {
    throw new Error(
      `SendMessage plan_approval_response: no active agent_run for member ${toMemberId}. ` +
        `Recipient must be running or sleeping to receive plan approvals.`,
    );
  }

  const effectiveRunId = input.run_id ?? runId ?? null;
  const messageId = crypto.randomUUID();
  const createdAt = new Date();
  const content =
    structured.feedback ??
    (structured.approve ? 'plan approved' : 'plan rejected');

  await db.insert(teamMessages).values({
    id: messageId,
    runId: effectiveRunId,
    teamId,
    fromMemberId: currentMemberId,
    toMemberId,
    toAgentId: targetAgentId,
    type: 'user_prompt',
    messageType: 'plan_approval_response',
    content,
    summary: null,
    metadata: { approve: structured.approve },
    repliesToId: structured.request_id,
    createdAt,
  });

  // Wake the teammate so it resumes its plan promptly on approval/rejection.
  await wake(targetAgentId);

  await publishToRedis(teamId, {
    messageId,
    runId: effectiveRunId,
    from: currentMemberId,
    to: toMemberId,
    repliesToId: structured.request_id,
    approve: structured.approve,
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
    'Send a message to another agent. ' +
    '`to`: teammate name | agent_runs.id | "*" for broadcast (expensive, use sparingly). ' +
    '`summary`: 5-10 word UI preview. ' +
    '`message`: plain string for DM/broadcast, OR structured object for protocol responses. ' +
    'Examples: ' +
    '{"to":"researcher","summary":"task 1","message":"start task #1"} | ' +
    '{"to":"*","summary":"halt","message":"stop work, blocking bug"} | ' +
    '{"to":"team-lead","message":{"type":"shutdown_response","request_id":"...","approve":true}}',
  inputSchema: SendMessageInputSchema,
  isConcurrencySafe: true,
  // INSERTs a row + PUBLISHes — unambiguously side-effecting.
  isReadOnly: false,
  // Engine fail-closed runtime validation. Two architectural rules that the
  // static zod schema cannot express:
  //   1. plan_approval_response is lead-only — only the team-lead can approve
  //      or reject teammate-submitted plans (engine PDF §2.4).
  //   2. broadcast (to: "*") is rate-limited to 1 per assistant turn (~5s
  //      window) per sender — broadcasts fan out to every teammate, so the
  //      engine prompt explicitly warns "broadcasting is expensive". Best-
  //      effort enforced by a SELECT against team_messages within the
  //      window.
  // Other shapes pass through untouched.
  async validateInput(input, ctx): Promise<ValidationResult> {
    if (
      typeof input.message === 'object' &&
      input.message.type === 'plan_approval_response'
    ) {
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

    if (input.to === '*') {
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
              'Use a direct DM (to: "<name>") for follow-up messages to a specific teammate.',
          };
        }
      }
    }

    return { result: true };
  },
  async execute(input, ctx): Promise<SendMessageResult> {
    // Dispatch by shape:
    //   - to === '*' + string message → broadcast
    //   - to !== '*' + string message → plain DM
    //   - object message → discriminated by message.type
    // Each dispatcher inserts a different team_messages shape (messageType
    // column distinguishes them; the legacy `type` column keeps its
    // LLM-flow meaning). shutdown_request + plan_approval_response also
    // wake() the recipient.
    const deps: DispatchDeps = { ...readTeamContext(ctx), ctx };

    // Broadcast path: `to: "*"` + string message.
    if (input.to === '*') {
      if (typeof input.message !== 'string') {
        throw new Error(
          'SendMessage broadcast: structured messages cannot be broadcast (to: "*"). ' +
            'Send protocol responses to a specific teammate.',
        );
      }
      // Cast: TS can't narrow the union via the runtime check above.
      return dispatchBroadcast(
        input as SendMessageInput & { message: string },
        deps,
      );
    }

    // Plain DM: regular text message to one teammate.
    if (typeof input.message === 'string') {
      return dispatchMessage(
        input as SendMessageInput & { message: string },
        deps,
      );
    }

    // Structured protocol response: dispatch by message.type.
    switch (input.message.type) {
      case 'shutdown_request':
        return dispatchShutdownRequest(input, input.message, deps);
      case 'shutdown_response':
        return dispatchShutdownResponse(input, input.message, deps);
      case 'plan_approval_response':
        return dispatchPlanApprovalResponse(input, input.message, deps);
    }
  },
});
