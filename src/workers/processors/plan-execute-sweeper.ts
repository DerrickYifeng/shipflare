import type { Job } from 'bullmq';
import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { planItems, teamMembers, teams } from '@/lib/db/schema';
import { enqueuePlanExecute } from '@/lib/queue/plan-execute';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { createAutomationConversation } from '@/lib/team-conversation-helpers';
import { recordPipelineEventsBulk } from '@/lib/pipeline-events';
import { createLogger, loggerForJob } from '@/lib/logger';
import { nextDispatchPhase } from '@/lib/plan-state';

const log = createLogger('worker:plan-execute-sweeper');

/**
 * How many rows to hand off per cron tick. A burst cap keeps a
 * cold-start backlog from flooding the queue in one minute; the
 * next tick picks up the rest.
 */
const MAX_PER_TICK = 200;

/**
 * Every-minute sweeper. Finds plan_items whose state + userAction
 * combination means they're ready for the next plan-execute phase,
 * AND whose scheduledAt has passed.
 *
 * Two dispatch paths from this sweep:
 *
 * 1. **content_post draft batch (Phase J Task 2)** — content_post rows
 *    in `state='planned' + userAction='approve'` and due go through
 *    one team-run per user with content-manager(post_batch). The
 *    sweeper atomically flips `planned → drafting` to claim rows
 *    before dispatching, so concurrent ticks don't double-fire.
 *    `draft_post` advances `drafting → drafted` once the writer
 *    persists.
 *
 * 2. **per-row plan-execute jobs** — every other (kind, phase) combo:
 *    - state='planned' + userAction IN ('approve','auto') + due →
 *      `draft` or `execute` phase (per nextDispatchPhase).
 *    - state='approved' → `execute` phase (skip scheduledAt; the user
 *      already approved).
 *
 * Manual-action rows are NOT swept — the user marks them complete
 * via API directly (Phase 8).
 *
 * The sweeper is idempotent on path 2 (enqueuePlanExecute dedupes on
 * `(planItemId, phase)` at the Redis level) and on path 1 (the
 * planned → drafting UPDATE filters on `state='planned'`, so a
 * re-sweep claims zero rows).
 */
export async function processPlanExecuteSweeper(
  job: Job<Record<string, never>>,
): Promise<void> {
  const jlog = loggerForJob(log, job);
  const now = new Date();

  const perUser = new Map<string, number>();

  // ------------------------------------------------------------------
  // Path 1 — content_post draft batch.
  //
  // Pulls due content_post rows in planned + approve, groups by user,
  // atomically claims them via planned → drafting, and dispatches ONE
  // content-manager(post_batch) team-run per user.
  // ------------------------------------------------------------------
  const batchedDrafts = await dispatchContentPostBatch(now, jlog);
  for (const [userId, count] of batchedDrafts) {
    perUser.set(userId, (perUser.get(userId) ?? 0) + count);
  }

  // ------------------------------------------------------------------
  // Path 2 — per-row plan-execute jobs for every other (kind, phase)
  // combination.
  //
  // We re-query AFTER the batch claim so already-claimed rows are
  // gone (state='drafting' now). The `or` block also skips any
  // content_post + draft-phase residue that the batch path didn't
  // claim (e.g. team membership missing) — those rows stay in
  // `planned` and will be retried next tick.
  // ------------------------------------------------------------------
  const candidates = await db
    .select({
      id: planItems.id,
      userId: planItems.userId,
      kind: planItems.kind,
      state: planItems.state,
      userAction: planItems.userAction,
    })
    .from(planItems)
    .where(
      or(
        and(
          eq(planItems.state, 'planned'),
          inArray(planItems.userAction, ['approve', 'auto']),
          lte(planItems.scheduledAt, now),
        ),
        eq(planItems.state, 'approved'),
      ),
    )
    .limit(MAX_PER_TICK);

  let enqueued = 0;
  for (const row of candidates) {
    const phase = nextDispatchPhase(row.state, row.userAction);
    if (!phase) continue;
    // Path 1 owns content_post draft; the batch dispatcher already
    // either claimed the row (it's in `drafting` now) or skipped it
    // for a recoverable reason. Either way the per-row queue has no
    // business firing for it.
    if (isContentPostDraftPhase(row.kind, phase)) continue;
    try {
      await enqueuePlanExecute({
        schemaVersion: 1,
        planItemId: row.id,
        userId: row.userId,
        phase,
      });
      enqueued++;
      perUser.set(row.userId, (perUser.get(row.userId) ?? 0) + 1);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      jlog.error(
        `failed to enqueue plan-execute for ${row.id} (phase=${phase}): ${msg}`,
      );
    }
  }

  // Emit a per-user aggregate event so the pipeline_events feed shows
  // whether this cron tick actually produced any enqueues. Swallows
  // insert errors internally — telemetry never breaks the sweep.
  if (perUser.size > 0) {
    await recordPipelineEventsBulk(
      [...perUser.entries()].map(([userId, count]) => ({
        userId,
        stage: 'sweeper_run',
        metadata: { sweeper: 'plan-execute', enqueued: count },
      })),
    );
  }

  const totalDispatched = enqueued + sum(batchedDrafts.values());
  jlog.info(
    `swept ${candidates.length} candidates + ${batchedDrafts.size} content_post batches, ` +
      `dispatched ${totalDispatched} draft/execute units across ${perUser.size} users`,
  );
}

function isContentPostDraftPhase(
  kind: string,
  phase: 'draft' | 'execute',
): boolean {
  return kind === 'content_post' && phase === 'draft';
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * Pull due content_post + planned + approve rows, group by user, and
 * for each user atomically claim the rows (planned → drafting) and
 * dispatch ONE content-manager(post_batch) team-run.
 *
 * Returns a map of `userId → claimed-count` so the caller can fold the
 * counts into the cross-path per-user aggregate.
 */
async function dispatchContentPostBatch(
  now: Date,
  jlog: ReturnType<typeof loggerForJob>,
): Promise<Map<string, number>> {
  const dispatched = new Map<string, number>();

  const candidates = await db
    .select({
      id: planItems.id,
      userId: planItems.userId,
      productId: planItems.productId,
    })
    .from(planItems)
    .where(
      and(
        eq(planItems.kind, 'content_post'),
        eq(planItems.state, 'planned'),
        eq(planItems.userAction, 'approve'),
        lte(planItems.scheduledAt, now),
      ),
    )
    .limit(MAX_PER_TICK);

  if (candidates.length === 0) return dispatched;

  // Group by (userId, productId). The team is product-scoped, so two
  // products belonging to the same user dispatch separate team-runs.
  const groups = new Map<
    string,
    {
      userId: string;
      productId: string;
      ids: string[];
    }
  >();
  for (const row of candidates) {
    const key = `${row.userId}::${row.productId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.ids.push(row.id);
    } else {
      groups.set(key, { userId: row.userId, productId: row.productId, ids: [row.id] });
    }
  }

  for (const group of groups.values()) {
    try {
      const dispatchedCount = await dispatchOneUserBatch(group, jlog);
      if (dispatchedCount > 0) {
        dispatched.set(
          group.userId,
          (dispatched.get(group.userId) ?? 0) + dispatchedCount,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      jlog.error(
        `content_post batch dispatch failed for user=${group.userId} product=${group.productId}: ${msg}`,
      );
    }
  }

  return dispatched;
}

interface UserBatchGroup {
  userId: string;
  productId: string;
  ids: string[];
}

/**
 * Atomically claim the candidate rows (planned → drafting) for one
 * user/product, then dispatch a single content-manager(post_batch)
 * team-run. Returns the number of rows actually claimed (0 means
 * another tick already dispatched, or no team yet exists).
 */
async function dispatchOneUserBatch(
  group: UserBatchGroup,
  jlog: ReturnType<typeof loggerForJob>,
): Promise<number> {
  // Look up the team + content-manager member BEFORE claiming. If the
  // team doesn't yet have content-manager (older default-squad team
  // pre-Phase-J reconcile), bail out without claiming so the rows
  // stay claimable on the next tick once the roster catches up.
  const memberRow = await findContentManagerMember(group.userId, group.productId);
  if (!memberRow) {
    jlog.warn(
      `content_post batch: no content-manager member for user=${group.userId} product=${group.productId} — leaving rows in planned`,
    );
    return 0;
  }

  // Atomic claim — UPDATE only flips rows that are still planned. The
  // returning() list tells us which ids actually transitioned, so the
  // post_batch goal carries only the rows we own.
  const claimed = await db
    .update(planItems)
    .set({ state: 'drafting', updatedAt: sql`now()` })
    .where(
      and(
        inArray(planItems.id, group.ids),
        eq(planItems.state, 'planned'),
      ),
    )
    .returning({ id: planItems.id });

  if (claimed.length === 0) {
    // Another tick or a manual approve already moved these rows.
    return 0;
  }

  const planItemIds = claimed.map((r) => r.id);
  const goal =
    `Mode: post_batch\n` +
    `planItemIds: ${JSON.stringify(planItemIds)}\n\n` +
    `Draft ${planItemIds.length} original-post(s). For each id, call ` +
    `query_plan_items to load the row, query_product_context once for ` +
    `shared product context, then run the post_batch workflow per ` +
    `AGENT.md (drafting-post → validate_draft → validating-draft → ` +
    `draft_post). Persist via draft_post; that tool flips state to drafted.`;

  const conversationId = await createAutomationConversation(
    memberRow.teamId,
    'draft_post',
  );

  await enqueueTeamRun({
    teamId: memberRow.teamId,
    trigger: 'draft_post',
    goal,
    rootMemberId: memberRow.memberId,
    conversationId,
  });

  jlog.info(
    `content_post batch: dispatched team-run agent=content-manager team=${memberRow.teamId} user=${group.userId} planItemIds=${planItemIds.length}`,
  );

  return planItemIds.length;
}

interface ContentManagerLookup {
  teamId: string;
  memberId: string;
}

/**
 * Find the team for (userId, productId) and the content-manager
 * member id within it. Returns null if either is missing — older
 * teams provisioned before Phase J or default-squad teams without a
 * content-manager fall through and the sweeper retries next tick.
 */
async function findContentManagerMember(
  userId: string,
  productId: string,
): Promise<ContentManagerLookup | null> {
  const [teamRow] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.userId, userId), eq(teams.productId, productId)))
    .limit(1);
  if (!teamRow) return null;

  const [memberRow] = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, teamRow.id),
        eq(teamMembers.agentType, 'content-manager'),
      ),
    )
    .limit(1);
  if (!memberRow) return null;

  return { teamId: teamRow.id, memberId: memberRow.id };
}
