/**
 * Team kickoff bootstrap. Idempotent helper that fires a single kickoff
 * team-run the first time a (user, product, team) is observed, then
 * never again. The kickoff run produces the three artefacts the founder
 * sees on their first visit to /team:
 *   1. plan draft (content-planner)
 *   2. search calibration (search-strategist via calibrate_search_strategy)
 *   3. live discovery + draft (run_discovery_scan + community-manager)
 *
 * Called from `app/(app)/team/page.tsx` server component on every render —
 * the first call schedules the run, subsequent calls are cheap no-ops.
 * Keeping the trigger here (and not in `/api/onboarding/commit`) means the
 * AI team is visibly working when the founder lands on the team page,
 * not silently in the background while they're still on the onboarding
 * "thanks!" screen.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  products,
  strategicPaths,
  teamMembers,
  teamRuns,
} from '@/lib/db/schema';
import { getUserChannels } from '@/lib/user-channels';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { createAutomationConversation } from '@/lib/team-conversation-helpers';
import { finalizePendingOnboardingRuns } from '@/lib/onboarding-run-finalizer';
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
 * Idempotently enqueue the kickoff team-run for `(userId, teamId)`.
 *
 * Detection: we check `team_runs` for ANY past kickoff trigger row
 * (any status). One kickoff per team, ever — re-running is a manual
 * action, not an automatic one.
 */
export async function ensureKickoffEnqueued(args: {
  userId: string;
  productId: string;
  teamId: string;
}): Promise<EnsureKickoffResult> {
  const { userId, productId, teamId } = args;

  // Has this team ever kicked off? Status doesn't matter — running,
  // completed, or failed all count. The founder gets one shot at
  // the auto-kickoff; manual re-runs go through /api/team/run.
  const existing = await db
    .select({ id: teamRuns.id })
    .from(teamRuns)
    .where(and(eq(teamRuns.teamId, teamId), eq(teamRuns.trigger, 'kickoff')))
    .limit(1);
  if (existing.length > 0) {
    return { fired: false, reason: 'already_kickoffed' };
  }

  // Pre-empt the analyst-run race: if the analyst's onboarding-trigger
  // run is still flagged `running` when we arrive at /team, the
  // `enqueueTeamRun` partial unique index would treat the team as busy
  // and silently return `alreadyRunning: true`, leaving us pointing at
  // the wrong run. Mark any in-flight onboarding run cancelled before
  // we enqueue so the index clears.
  try {
    const finalized = await finalizePendingOnboardingRuns(teamId);
    if (finalized.finalized > 0) {
      log.info(
        `kickoff finalized ${finalized.finalized} stale onboarding run(s) ahead of kickoff: [${finalized.runIds.join(',')}]`,
      );
    }
  } catch (err) {
    log.warn(
      `finalizePendingOnboardingRuns failed (non-fatal) team=${teamId}: ${err instanceof Error ? err.message : String(err)}`,
    );
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
  // calendar anchor for content-planner, primary platform for calibration,
  // channel list for the skip-with-message branch. Detailed step ordering
  // lives in the playbook so we can change it without redeploying API code.
  const goal =
    `First-visit kickoff for ${productRow.name}. ` +
    (pathId ? `Strategic path pathId=${pathId}. ` : '') +
    `weekStart=${kickoffWeekStart} now=${kickoffNow.toISOString()}. ` +
    `Connected channels: ${channels.join(', ') || 'none'}. ` +
    `Trigger: kickoff. ` +
    `Follow your kickoff playbook end-to-end: ` +
    `(1) Task content-planner for week-1 plan items — pass weekStart + now in its prompt verbatim, ` +
    `(2) call calibrate_search_strategy({ platform: '${primary}' }), ` +
    `(3) call run_discovery_scan({ platform: '${primary}' }), ` +
    `(4) Task community-manager on the top-3 queued threads. ` +
    `Skip steps 2-4 if no channels are connected.`;

  let conversationId: string;
  try {
    conversationId = await createAutomationConversation(teamId, 'kickoff');
  } catch (err) {
    log.warn(
      `createAutomationConversation failed for kickoff team=${teamId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { fired: false, reason: 'enqueue_failed' };
  }

  try {
    const { runId } = await enqueueTeamRun({
      teamId,
      trigger: 'kickoff',
      goal,
      rootMemberId: coordinator.id,
      conversationId,
    });
    log.info(
      `kickoff enqueued user=${userId} team=${teamId} run=${runId} conv=${conversationId}`,
    );
    return { fired: true, runId, conversationId };
  } catch (err) {
    log.warn(
      `enqueueTeamRun failed for kickoff team=${teamId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { fired: false, reason: 'enqueue_failed', conversationId };
  }
}
