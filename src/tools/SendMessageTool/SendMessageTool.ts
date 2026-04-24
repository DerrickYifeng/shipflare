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
import { and, eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolContext, ToolDefinition } from '@/core/types';
import { createLogger } from '@/lib/logger';
import { db as defaultDb, type Database } from '@/lib/db';
import { teamMembers, teamMessages } from '@/lib/db/schema';
import { getPubSubPublisher } from '@/lib/redis';

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
 * coordinator (Phase D Day 3). `/api/team/message` publishes a JSON
 * payload `{ content: string }` here when the user sends a message to
 * an active run; the team-run worker's subscriber accumulates them in
 * a FIFO and drains into the conversation at the next turn boundary.
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

export const SendMessageInputSchema = z
  .object({
    /** memberId (uuid-like) OR display_name; scoped to the caller's team. */
    to: z.string().min(1, 'to is required'),
    message: z.string().min(1, 'message is required'),
    run_id: z.string().optional(),
  })
  .strict();

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
  inputSchema: SendMessageInputSchema,
  isConcurrencySafe: true,
  // INSERTs a row + PUBLISHes — unambiguously side-effecting.
  isReadOnly: false,
  async execute(input, ctx): Promise<SendMessageResult> {
    const { teamId, currentMemberId, runId, db } = readTeamContext(ctx);

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
      content: input.message,
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
    });

    return { delivered: true, messageId, toMemberId };
  },
});
