/**
 * Daily-run dispatch helper. Mirrors `ensureKickoffEnqueued` in shape
 * but emits the daily goal preamble (built by `buildDailyGoalText`)
 * instead of the kickoff one — intended for the recurring 13:00 UTC
 * cron fan-out.
 *
 *   kickoff (one-shot, first /team visit):
 *     seed plan_items → spawn one social-media-manager per (channel × mode)
 *
 *   daily (every cron tick):
 *     load today's content_reply slots →
 *     spawn one social-media-manager per (channel, reply), parallelized.
 *     content_post drafting is owned by `plan-execute-sweeper` and runs
 *     directly via `processPostsBatchTool` — daily never spawns post-batch
 *     agents (would race the sweeper for already-claimed rows).
 *
 * The full per-trigger logic lives in the goal preamble (see
 * `buildDailyGoalText` below). AGENT.md no longer carries trigger
 * playbooks — it only owns generic orchestration teaching.
 *
 * No idempotency check: the cron may legitimately enqueue multiple times
 * (BullMQ retry, missed-window catch-up, manual re-enqueue). The lead's
 * `wake()` collapses duplicate enqueues within a 1-second BullMQ jobId
 * window, and the daily goal directives are themselves idempotent
 * (re-reading the same slots, dispatching the same agents).
 *
 * Both kickoff and daily share `dispatchLeadMessage` so the runtime model
 * stays uniform: every founder-or-system trigger inserts a user_prompt
 * `team_messages` row + wakes the team-lead agent. There is no separate
 * "automation run" code path — see CLAUDE.md "Founder UI mental model".
 */

import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { products, strategicPaths } from '@/lib/db/schema';
import { dispatchLeadMessage } from '@/lib/team/dispatch-lead-message';
import { resolveRollingConversation } from '@/lib/team-rolling-conversation';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:team-daily-run');

export interface EnsureDailyRunResult {
  fired: boolean;
  reason?: 'no_product' | 'enqueue_failed';
  runId?: string;
  conversationId?: string;
}

/**
 * Dispatch the daily-run lead message for `(userId, teamId)`. Caller has
 * already established the team exists (cron fan-out runs ensureTeamExists
 * before invoking this). The platform list is passed in by the caller —
 * we don't re-derive it here so the cron's existing channel-aggregation
 * pass remains the SSOT.
 */
export async function ensureDailyRunEnqueued(args: {
  userId: string;
  productId: string;
  teamId: string;
  /** Connected channels for goal-text + skip detection. Empty = no channels. */
  platforms: readonly string[];
  /** Optional source label preserved in goal text for observability. */
  source?: string;
}): Promise<EnsureDailyRunResult> {
  const { userId, productId, teamId, platforms, source } = args;

  const [productRow] = await db
    .select({ name: products.name })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!productRow) {
    return { fired: false, reason: 'no_product' };
  }

  let conversationId: string;
  try {
    conversationId = await resolveRollingConversation(teamId, 'Discovery');
  } catch (err) {
    log.warn(
      `resolveRollingConversation failed for daily-run team=${teamId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { fired: false, reason: 'enqueue_failed' };
  }

  // Read the active strategic path's channelMix so the goal preamble
  // can carry per-channel repliesPerDay budgets verbatim. Daily does
  // NOT add plan_items — kickoff + weekly-replan own that — but it
  // does need to know each channel's reply budget so the spawn
  // directives carry the right targetCount when no slot row exists
  // (fallback path on misconfigured users).
  const [activePath] = await db
    .select({
      id: strategicPaths.id,
      channelMix: strategicPaths.channelMix,
    })
    .from(strategicPaths)
    .where(eq(strategicPaths.userId, userId))
    .orderBy(strategicPaths.generatedAt)
    .limit(1);

  const goal = buildDailyGoalText({
    productName: productRow.name,
    platforms,
    source,
    channelMix: (activePath?.channelMix ?? null) as Record<
      string,
      { repliesPerDay?: number | null } | null | undefined
    > | null,
  });

  const publicSummary = `Running your daily automation for ${productRow.name}.`;

  try {
    const { runId } = await dispatchLeadMessage(
      {
        teamId,
        conversationId,
        goal,
        publicSummary,
        trigger: 'daily',
        // B6: cron-driven daily fan-out → backfill lane (not founder traffic).
        priority: 'backfill',
      },
      db,
    );
    log.info(
      `daily-run dispatched user=${userId} team=${teamId} run=${runId} conv=${conversationId}`,
    );
    return { fired: true, runId, conversationId };
  } catch (err) {
    log.warn(
      `dispatchLeadMessage failed for daily-run team=${teamId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { fired: false, reason: 'enqueue_failed', conversationId };
  }
}

interface DailyGoalArgs {
  productName: string;
  platforms: readonly string[];
  source?: string;
  channelMix: Record<
    string,
    { repliesPerDay?: number | null } | null | undefined
  > | null;
}

/**
 * Build the daily-run goal preamble. The coordinator reads this
 * verbatim — every spawn directive lives here, not in AGENT.md.
 *
 * Daily does NOT add new plan_items (kickoff + weekly-replan own
 * that). Daily ALSO does not dispatch content_post drafting — the
 * every-minute `plan-execute-sweeper` already owns that path via
 * `processPostsBatchTool` (no agent spawn, just the tool). Daily
 * only handles content_reply discovery + drafting:
 *
 *   1. For each connected channel where repliesPerDay > 0, spawn ONE
 *      social-media-manager in (channel, reply) mode against today's
 *      content_reply slot. The coordinator queries the slot's uuid
 *      itself — we just tell it which channels to look at.
 *   2. Parallelize all spawns in a single assistant turn.
 *
 * Channels without reply budget are silently skipped — no spawn
 * directive is emitted.
 */
export function buildDailyGoalText(args: DailyGoalArgs): string {
  const { productName, platforms, source, channelMix } = args;

  const platformList = platforms.length > 0 ? platforms.join(', ') : 'none';
  const sourceClause = source ? `Source: ${source}.` : '';

  const repliesX = readDailyRepliesPerDay(channelMix, 'x');
  const repliesReddit = readDailyRepliesPerDay(channelMix, 'reddit');
  const xConnected = platforms.includes('x');
  const redditConnected = platforms.includes('reddit');

  // `channel:` is a structured prompt field — pairs with the kickoff
  // builder (team-kickoff.ts). The description string is human-facing
  // and the agent skims past it; the structured field is what
  // patterns-and-examples.md tells the agent to read for the discovery
  // platform argument. See team-kickoff.ts for the incident write-up.
  const replySpawns: string[] = [];
  if (xConnected && repliesX > 0) {
    replySpawns.push(
      `- (x, reply): Task({ subagent_type: 'social-media-manager', description: 'fill x reply slot', prompt: 'Mode: discover-and-fill-slot\\nchannel: x\\nplanItemId: <today's x content_reply uuid, or "(none)" if no slot exists>\\ntargetCount: ${repliesX}' })`,
    );
  }
  if (redditConnected && repliesReddit > 0) {
    replySpawns.push(
      `- (reddit, reply): Task({ subagent_type: 'social-media-manager', description: 'fill reddit reply slot', prompt: 'Mode: discover-and-fill-slot\\nchannel: reddit\\nplanItemId: <today's reddit content_reply uuid, or "(none)" if no slot exists>\\ntargetCount: ${repliesReddit}' })`,
    );
  }

  const lines: string[] = [
    `Daily automation run for ${productName}.`,
    `Connected platforms: ${platformList}.`,
    `Trigger: daily.${sourceClause ? ' ' + sourceClause : ''}`,
    ``,
    `Daily does NOT add new plan_items — kickoff + weekly-replan own that.`,
    `Daily does NOT dispatch content_post drafting — the plan-execute-sweeper`,
    `runs every minute and claims due content_post rows directly via`,
    `processPostsBatchTool. Daily only fills today's content_reply slots.`,
    ``,
    `Per-channel reply budget (read off the active strategic path):`,
    `- x: ${repliesX} replies/day`,
    `- reddit: ${repliesReddit} replies/day`,
    ``,
  ];

  if (replySpawns.length > 0) {
    lines.push(
      `Step 1 — query_plan_items({ status: ['planned'] }) to find today's content_reply rows. Group by channel.`,
      ``,
      `Step 2 — Dispatch all of the following Task spawns IN A SINGLE ASSISTANT TURN (engine accepts multiple tool_use blocks per turn — parallelize). Skip any directive whose corresponding slot row doesn't exist for today:`,
      ...replySpawns,
      ``,
      `Step 3 — As each <task-notification> arrives, call update_plan_item({ id: <touched uuid>, state: 'drafted' }) for the slot(s) that task drafted for.`,
    );
  } else {
    lines.push(
      `No connected channels with active reply budget. Skip dispatch and tell the founder which channel they should connect.`,
    );
  }

  return lines.join('\n');
}

function readDailyRepliesPerDay(
  channelMix: DailyGoalArgs['channelMix'],
  ch: 'x' | 'reddit',
): number {
  if (!channelMix) return 0;
  const entry = channelMix[ch];
  if (!entry) return 0;
  const v = entry.repliesPerDay;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}
