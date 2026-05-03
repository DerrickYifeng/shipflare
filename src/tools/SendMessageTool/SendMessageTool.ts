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
  // `z.preprocess(...)` returns a `ZodEffects` whose declared input type is
  // `unknown` (the preprocessor accepts any raw payload). buildTool expects
  // `z.ZodType<TInput>` with input = output, so we cast to the post-process
  // shape. Runtime parsing still goes through the preprocessor — only the
  // compile-time generic is being aligned.
  inputSchema: SendMessageInputSchema as unknown as z.ZodType<SendMessageInput>,
  isConcurrencySafe: true,
  // INSERTs a row + PUBLISHes — unambiguously side-effecting.
  isReadOnly: false,
  async execute(input, ctx): Promise<SendMessageResult> {
    // Phase C Task 1: schema is now a 5-variant discriminated union, but
    // execute() is still single-path until Task 2 wires the dispatcher.
    // For Task 1 we narrow to `type: 'message'` (the legacy shape every
    // current caller sends via the preprocessor) and reject the other
    // variants with a clear error so we surface any premature use.
    if (input.type !== 'message') {
      throw new Error(
        `SendMessage: type="${input.type}" is recognized by the schema but ` +
          `dispatcher is not yet wired (Phase C Task 2). Caller should use ` +
          `type="message" until Task 2 lands.`,
      );
    }

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
      content: input.content,
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
    });

    return { delivered: true, messageId, toMemberId };
  },
});
