/**
 * Daily-run dispatch helper. Mirrors `ensureKickoffEnqueued` in shape but
 * runs the COORDINATOR'S DAILY PLAYBOOK instead of the kickoff playbook —
 * intended for the recurring 13:00 UTC cron fan-out.
 *
 *   kickoff (one-shot, first /team visit):
 *     plan → social-media-manager (discovery + drafting per slot)
 *
 *   daily (every cron tick):
 *     load today's content_reply plan_items → social-media-manager per slot
 *
 * No idempotency check: the cron may legitimately enqueue multiple times
 * (BullMQ retry, missed-window catch-up, manual re-enqueue). The lead's
 * `wake()` collapses duplicate enqueues within a 1-second BullMQ jobId
 * window, and the coordinator's daily playbook is itself idempotent
 * (re-reading the same plan_items, dispatching the same agents).
 *
 * Both kickoff and daily share `dispatchLeadMessage` so the runtime model
 * stays uniform: every founder-or-system trigger inserts a user_prompt
 * `team_messages` row + wakes the team-lead agent. There is no separate
 * "automation run" code path — see CLAUDE.md "Founder UI mental model".
 */

import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
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

  const platformList = platforms.length > 0 ? platforms.join(', ') : 'none';
  const sourceClause = source ? ` Source: ${source}.` : '';
  const goal =
    `Daily automation run for ${productRow.name}. ` +
    `Connected platforms: ${platformList}. ` +
    `Trigger: daily.${sourceClause} ` +
    `Follow your daily playbook: load today's content_reply plan_items ` +
    `for this user, dispatch ONE social-media-manager per slot (it runs ` +
    `discovery + judging + drafting internally), and update_plan_item ` +
    `state='drafted' when each slot terminates. If no slots are found, ` +
    `fall back to a single social-media-manager dispatch with mode ` +
    `discover-and-fill-slot for the primary connected channel.`;

  const publicSummary = `Running your daily automation for ${productRow.name}.`;

  try {
    const { runId } = await dispatchLeadMessage(
      {
        teamId,
        conversationId,
        goal,
        publicSummary,
        trigger: 'daily',
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
