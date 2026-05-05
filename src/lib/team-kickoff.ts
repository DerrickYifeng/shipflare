/**
 * Team kickoff bootstrap. Idempotent helper that dispatches a single
 * kickoff lead message the first time a (user, product, team) is
 * observed, then never again. The kickoff run produces the three
 * artefacts the founder sees on their first visit to /team:
 *   1. plan draft (coordinator's add_plan_item tool — direct, post-Plan-3)
 *   2. reply-target discovery (rolled into the social-media-manager spawn)
 *   3. draft replies (social-media-manager on the discovered top targets)
 *
 * Called from `app/(app)/team/page.tsx` server component on every render —
 * the first call schedules the run, subsequent calls are cheap no-ops.
 * Keeping the trigger here (and not in `/api/onboarding/commit`) means the
 * AI team is visibly working when the founder lands on the team page,
 * not silently in the background while they're still on the onboarding
 * "thanks!" screen.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  products,
  strategicPaths,
  teamMembers,
  teamMessages,
} from '@/lib/db/schema';
import { getUserChannels } from '@/lib/user-channels';
import { dispatchLeadMessage } from '@/lib/team/dispatch-lead-message';
import { createAutomationConversation } from '@/lib/team-conversation-helpers';
import { currentWeekStart } from '@/lib/week-bounds';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:team-kickoff');

export interface EnsureKickoffResult {
  fired: boolean;
  reason?: 'already_kickoffed' | 'no_product' | 'no_coordinator' | 'enqueue_failed';
  runId?: string;
  conversationId?: string;
}

/**
 * Idempotently dispatch the kickoff lead message for `(userId, teamId)`.
 *
 * Detection: we look in `team_messages.metadata.trigger` for ANY past
 * `kickoff` row (any status). One kickoff per team, ever — re-running
 * is a manual action, not an automatic one.
 */
export async function ensureKickoffEnqueued(args: {
  userId: string;
  productId: string;
  teamId: string;
}): Promise<EnsureKickoffResult> {
  const { userId, productId, teamId } = args;

  // Has this team ever kicked off? Status doesn't matter — we just want
  // the founder's one-shot auto-kickoff. `dispatchLeadMessage` stamps
  // `metadata.trigger` on every user_prompt, so a single SELECT on
  // team_messages is the source of truth. Manual re-runs go through
  // /api/team/run as before.
  const existing = await db
    .select({ id: teamMessages.id })
    .from(teamMessages)
    .where(
      and(
        eq(teamMessages.teamId, teamId),
        sql`${teamMessages.metadata}->>'trigger' = 'kickoff'`,
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return { fired: false, reason: 'already_kickoffed' };
  }

  const [productRow] = await db
    .select({ name: products.name })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!productRow) {
    return { fired: false, reason: 'no_product' };
  }

  const memberRows = await db
    .select({ id: teamMembers.id, agentType: teamMembers.agentType })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  const coordinator = memberRows.find((m) => m.agentType === 'coordinator');
  if (!coordinator) {
    return { fired: false, reason: 'no_coordinator' };
  }

  const channels = await getUserChannels(userId);
  const primary = channels.includes('x') ? 'x' : channels[0] ?? 'x';

  // Pre-compute the calendar anchor so coordinator can pass it verbatim
  // to content-planner. Without `weekStart=` / `now=` in the goal the
  // planner has to infer them from the model's clock and historically
  // picked next Monday — leaving /today and /calendar empty until the
  // following ISO week. See coordinator/AGENT.md `trigger: 'kickoff'`.
  const kickoffNow = new Date();
  const kickoffWeekStart = currentWeekStart(kickoffNow).toISOString();

  // Look up the active strategic path so content-planner can anchor its
  // pillar selection. Optional — kickoff still fires if the path is
  // missing (the planner will ask). The schema has only one path per
  // user today, so a single SELECT with a generatedAt tiebreak picks
  // the latest after any future replan.
  const [activePath] = await db
    .select({ id: strategicPaths.id })
    .from(strategicPaths)
    .where(eq(strategicPaths.userId, userId))
    .orderBy(strategicPaths.generatedAt)
    .limit(1);
  const pathId = activePath?.id ?? null;

  // The kickoff playbook is in coordinator/AGENT.md (`trigger: 'kickoff'`).
  // The goal text gives the coordinator just enough context to dispatch:
  // calendar anchor for direct add_plan_item calls, social-media-manager
  // for combined discovery + drafting, channel list for the skip-with-message
  // branch. Detailed step ordering lives in the playbook so we can change
  // it without redeploying API code.
  const goal =
    `First-visit kickoff for ${productRow.name}. ` +
    (pathId ? `Strategic path pathId=${pathId}. ` : '') +
    `weekStart=${kickoffWeekStart} now=${kickoffNow.toISOString()}. ` +
    `Connected channels: ${channels.join(', ') || 'none'}. ` +
    `Trigger: kickoff. ` +
    `Follow your kickoff playbook end-to-end (plan → social-media-manager): ` +
    `(1) Generate week-1 plan items directly with your add_plan_item tool — pass weekStart + now verbatim. ` +
    `(2) Look up today's content_reply slot for the primary channel via query_plan_items (kind=content_reply, today's UTC scheduledAt) and read params.targetCount. ` +
    `(3) Task({ subagent_type: 'social-media-manager', description: 'fill reply slot', prompt: 'Mode: discover-and-fill-slot\\nplanItemId: <uuid>\\ntargetCount: <slot.targetCount>' }) — the agent runs discovery + judging + drafting internally and returns one StructuredOutput. The description stays a short verb phrase (no UUID); the planItemId travels in the prompt body. ` +
    `Skip steps 2-3 if no channels are connected.`;

  let conversationId: string;
  try {
    conversationId = await createAutomationConversation(teamId, 'kickoff');
  } catch (err) {
    log.warn(
      `createAutomationConversation failed for kickoff team=${teamId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { fired: false, reason: 'enqueue_failed' };
  }

  void coordinator; // resolved for misconfiguration check; lead is the sole recipient
  // Founder-facing summary persisted into metadata.publicContent. The
  // redactor at the API boundary swaps this into `content` when serving
  // the row to the browser; the raw `goal` (with internal architecture
  // details — playbook, agent names, mode strings) stays server-side
  // for the lead's agent-run replay. See dispatchLeadMessage docs.
  const publicSummary = pathId
    ? `Building ${productRow.name}'s first-week plan and drafting your first reply candidates.`
    : `Building ${productRow.name}'s first-week plan.`;
  try {
    const { runId } = await dispatchLeadMessage(
      {
        teamId,
        conversationId,
        goal,
        publicSummary,
        trigger: 'kickoff',
      },
      db,
    );
    log.info(
      `kickoff dispatched user=${userId} team=${teamId} run=${runId} conv=${conversationId}`,
    );
    return { fired: true, runId, conversationId };
  } catch (err) {
    log.warn(
      `dispatchLeadMessage failed for kickoff team=${teamId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { fired: false, reason: 'enqueue_failed', conversationId };
  }
}
