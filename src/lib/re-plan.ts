import { and, eq, gte, lt, inArray, ne, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { planItems, products, strategicPaths } from '@/lib/db/schema';
import { derivePhase, type ProductState } from '@/lib/launch-phase';
import { getUserChannels } from '@/lib/user-channels';
import { ensureTeamExists } from '@/lib/team-provisioner';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { createAutomationConversation } from '@/lib/team-conversation-helpers';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:re-plan');

/**
 * Tactical re-plan supersede — see spec §7.1.
 *
 * Marks items inside `[weekStart, weekEnd)` that are still in a
 * pre-approval state as `superseded`. Leaves `approved / executing /
 * completed / skipped / failed / stale` alone so in-flight work and
 * finished history are preserved.
 *
 * `manual` userAction items (interviews, setup tasks) are NEVER
 * superseded — the founder is committed to them, so the planner
 * doesn't get to reshuffle them mid-week.
 *
 * The caller runs this BEFORE enqueuing the team-run so the 7-day
 * window is cleaned out in one pass. Returns the count of rows
 * marked.
 *
 * Idempotent: calling twice with the same args has no additional
 * effect on the second call (all target rows have already moved out
 * of the three pre-approval states).
 */
export interface SupersedeWindow {
  userId: string;
  /** ISO (inclusive). Typically Monday 00:00 UTC. */
  windowStart: Date;
  /** ISO (exclusive). Typically `windowStart + 7d`. */
  windowEnd: Date;
  /**
   * Optional filter. When present, only items with
   * `kind IN kinds` get superseded. Default: all kinds
   * (the normal Monday replan sweep).
   */
  kinds?: string[];
}

const PRE_APPROVAL_STATES = ['planned', 'drafted', 'ready_for_review'] as const;

export async function supersedePlanItems(
  input: SupersedeWindow,
): Promise<number> {
  const { userId, windowStart, windowEnd, kinds } = input;

  if (windowEnd.getTime() <= windowStart.getTime()) {
    throw new Error(
      `supersedePlanItems: windowEnd (${windowEnd.toISOString()}) must be after windowStart (${windowStart.toISOString()})`,
    );
  }

  const conditions = [
    eq(planItems.userId, userId),
    gte(planItems.scheduledAt, windowStart),
    lt(planItems.scheduledAt, windowEnd),
    inArray(planItems.state, [...PRE_APPROVAL_STATES]),
    ne(planItems.userAction, 'manual'),
  ];
  if (kinds && kinds.length > 0) {
    conditions.push(inArray(planItems.kind, kinds as never[]));
  }

  const result = await db
    .update(planItems)
    .set({ state: 'superseded', updatedAt: sql`now()` })
    .where(and(...conditions))
    .returning({ id: planItems.id });

  const count = result.length;
  log.info(
    `superseded ${count} plan_items user=${userId} window=${windowStart.toISOString()}..${windowEnd.toISOString()}` +
      (kinds ? ` kinds=[${kinds.join(',')}]` : ''),
  );
  return count;
}

/**
 * Strategic re-plan supersede — see spec §7.2.
 *
 * Different from tactical: it deactivates ALL active strategic paths
 * for the user (there should only be one, but the uniqueness
 * constraint is partial so we defensively scan) and supersedes every
 * pre-approval plan_item regardless of window. The caller then
 * enqueues a team-run with trigger='phase_transition' to rebuild.
 *
 * This is the "phase change" / "launch date change" path. Accept the
 * cost of resetting the whole pipeline; it's infrequent.
 */
export async function supersedeForStrategicReplan(
  userId: string,
): Promise<number> {
  const result = await db
    .update(planItems)
    .set({ state: 'superseded', updatedAt: sql`now()` })
    .where(
      and(
        eq(planItems.userId, userId),
        inArray(planItems.state, [...PRE_APPROVAL_STATES]),
        ne(planItems.userAction, 'manual'),
      ),
    )
    .returning({ id: planItems.id });

  const count = result.length;
  log.info(
    `strategic replan: superseded ${count} plan_items user=${userId} (all pre-approval, all windows)`,
  );
  return count;
}

// ---------------------------------------------------------------------------
// Tactical replan — shared between POST /api/plan/replan and the Monday
// weekly-replan cron processor. Callers choose the `trigger` value
// (`manual` vs `weekly`) for the team_runs row.
//
// Phase C: the legacy in-transaction tactical-planner skill call is gone.
// The tactical replan now:
//   1. Reads the active strategic path (still required — we surface
//      `no_active_path` if the user hasn't committed one yet).
//   2. Intersects channelMix with currently-connected channels.
//   3. Supersedes the week's pre-approval items (still synchronous — we want
//      the /today UI to clear stale items the moment the replan button fires).
//   4. Enqueues a team_run; the coordinator delegates to content-planner which
//      writes new plan_items via add_plan_item.
//
// The call returns AFTER the enqueue, NOT after the team-run completes.
// Callers (both the API route and the cron) rely on the existing team-run
// SSE / observability path for progress. Drops the `plan` field and the
// `planner_timeout` soft-fail code from the legacy shape — the team-run is
// async and cannot synthesize a terminal TacticalPlan object.
// ---------------------------------------------------------------------------

export type ReplanTrigger = 'manual' | 'weekly';

export type ReplanResult =
  | {
      ok: true;
      runId: string;
      itemsSuperseded: number;
    }
  | {
      ok: false;
      code:
        | 'no_active_path'
        | 'no_channels_in_path'
        | 'team_run_enqueue_failed';
      detail?: string;
    };

function weekBounds(now: Date): { weekStart: Date; weekEnd: Date } {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  const dayOffset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayOffset);
  const weekStart = new Date(d);
  const weekEnd = new Date(d);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  return { weekStart, weekEnd };
}

/**
 * Load the user's product + active strategic path, supersede the week's
 * pre-approval items, and enqueue a team-run to produce the new items.
 *
 * Shared between:
 *   - POST /api/plan/replan (trigger='manual', user-initiated)
 *   - workers/processors/weekly-replan.ts (trigger='weekly', Monday 00:00 UTC)
 *
 * Does NOT acquire a lock — callers handle deduplication: the API route
 * via the request rate limit, the cron via the per-(user, week) Redis lock.
 */
export async function runTacticalReplan(
  userId: string,
  trigger: ReplanTrigger,
): Promise<ReplanResult> {
  const [row] = await db
    .select({
      productId: products.id,
      productName: products.name,
      state: products.state,
      launchDate: products.launchDate,
      launchedAt: products.launchedAt,
      pathChannelMix: strategicPaths.channelMix,
    })
    .from(products)
    .innerJoin(
      strategicPaths,
      and(
        eq(strategicPaths.userId, products.userId),
        eq(strategicPaths.isActive, true),
      ),
    )
    .where(eq(products.userId, userId))
    .limit(1);

  if (!row) return { ok: false, code: 'no_active_path' };

  const state = row.state as ProductState;
  const currentPhase = derivePhase({
    state,
    launchDate: row.launchDate ?? null,
    launchedAt: row.launchedAt ?? null,
  });
  const { weekStart, weekEnd } = weekBounds(new Date());

  // Intersect the strategic path's channelMix (the plan's intended
  // channels) with the user's currently-connected channels. If the user
  // disconnected a channel in Settings after the plan was written, it's
  // no longer executable — the planner shouldn't produce plan_items for
  // it. Email is an exception: it doesn't live in the `channels` table
  // (no OAuth), so we keep it whenever the path's channelMix lists it.
  const channelMix = row.pathChannelMix as Record<string, unknown> | null;
  const connected = new Set(await getUserChannels(userId));
  const channels: Array<'x' | 'reddit' | 'email'> = [];
  if (channelMix) {
    for (const k of ['x', 'reddit', 'email'] as const) {
      if (!channelMix[k]) continue;
      if (k === 'email' || connected.has(k)) channels.push(k);
    }
  }
  if (channels.length === 0) return { ok: false, code: 'no_channels_in_path' };

  log.info(
    `replan start user=${userId} trigger=${trigger} phase=${currentPhase} channels=[${channels.join(',')}] weekStart=${weekStart.toISOString()}`,
  );

  // Supersede the week's pre-approval items up front so the Today UI clears
  // stale entries the moment the replan button fires. The team-run writes
  // new items on its own timeline.
  const itemsSuperseded = await supersedePlanItems({
    userId,
    windowStart: weekStart,
    windowEnd: weekEnd,
  });

  // Ensure the team exists (idempotent) and enqueue a team-run. The
  // coordinator's goal prompt seeds the delegation to content-planner.
  let runId: string;
  try {
    const { teamId, memberIds } = await ensureTeamExists(userId, row.productId);
    const goal =
      `Re-plan week ${weekStart.toISOString().slice(0, 10)} for ${row.productName}. ` +
      `State: ${state}. Phase: ${currentPhase}. ` +
      `Channels: ${channels.join(', ')}. ` +
      (trigger === 'weekly'
        ? 'Monday cron replan — produce fresh plan_items for the coming 7 days.'
        : 'Manual replan — previous week items have been superseded; produce fresh plan_items for the coming 7 days.');

    const replanConvId = await createAutomationConversation(teamId, 'weekly');
    const enqueued = await enqueueTeamRun({
      teamId,
      trigger: trigger === 'weekly' ? 'weekly' : 'manual',
      goal,
      rootMemberId: memberIds.coordinator,
      conversationId: replanConvId,
    });
    runId = enqueued.runId;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error(`replan enqueue failed user=${userId}: ${detail}`);
    return { ok: false, code: 'team_run_enqueue_failed', detail };
  }

  log.info(
    `replan enqueued user=${userId} trigger=${trigger} runId=${runId} superseded=${itemsSuperseded}`,
  );

  return { ok: true, runId, itemsSuperseded };
}
