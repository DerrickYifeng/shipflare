import type { Job } from 'bullmq';
import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { planItems } from '@/lib/db/schema';
import { enqueuePlanExecute } from '@/lib/queue/plan-execute';
import { recordPipelineEventsBulk } from '@/lib/pipeline-events';
import { createLogger, loggerForJob } from '@/lib/logger';
import { nextDispatchPhase } from '@/lib/plan-state';
import { processPostsBatchTool } from '@/tools/ProcessPostsBatchTool/ProcessPostsBatchTool';
import { createToolContext } from '@/bridge/agent-runner';

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
 *    in `state='planned' + userAction='approve'` and due are handed
 *    directly to `processPostsBatchTool.execute()` (one tool call per
 *    user/product) — no `agent_run` spawn. The sweeper atomically
 *    flips `planned → drafting` to claim rows before invoking the
 *    tool, so concurrent ticks don't double-fire. The tool's internal
 *    `draft_post` step advances `drafting → drafted` once the writer
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
  // Pulls due content_post rows in planned + approve, groups by
  // (userId, productId), atomically claims them via planned →
  // drafting, and invokes `processPostsBatchTool` once per group.
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
 * invoke `processPostsBatchTool` directly (no `agent_run` spawn).
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

  // Group by (userId, productId). The product context is the tool's
  // dep, so two products belonging to the same user trigger separate
  // tool calls.
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
 * user/product, then invoke `processPostsBatchTool` directly. Returns
 * the number of rows actually claimed (0 means another tick already
 * dispatched).
 *
 * No `agent_run` is spawned — the tool's `execute()` IS the post
 * pipeline orchestrator. On tool dispatch failure we reset claimed
 * rows back to `planned` so a future tick retries.
 */
async function dispatchOneUserBatch(
  group: UserBatchGroup,
  jlog: ReturnType<typeof loggerForJob>,
): Promise<number> {
  // Atomic claim — UPDATE only flips rows that are still planned. The
  // returning() list tells us which ids actually transitioned, so the
  // tool call carries only the rows we own.
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

  // Pipeline-to-tools refactor: invoke the tool directly. The tool
  // handles drafting → drafted via its internal draftPostTool.execute()
  // calls. No team conversation, no agent_run — the sweeper is a cron
  // and the tool is its own orchestrator.
  const syntheticCtx = createToolContext({
    db,
    userId: group.userId,
    productId: group.productId,
  });

  try {
    const result = await processPostsBatchTool.execute(
      { planItemIds },
      syntheticCtx,
    );
    jlog.info(
      `content_post batch via tool: created=${result.draftsCreated} ` +
        `skipped=${result.draftsSkipped} for user=${group.userId} product=${group.productId}`,
    );
    return planItemIds.length;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    jlog.error(
      `content_post batch tool dispatch failed for user=${group.userId} product=${group.productId}: ${msg}`,
    );
    // Reset claimed rows back to 'planned' so the next tick retries.
    // Filter on state='drafting' so we don't clobber rows that the tool
    // already advanced to 'drafted' before throwing partway through.
    await db
      .update(planItems)
      .set({ state: 'planned', updatedAt: sql`now()` })
      .where(
        and(
          inArray(planItems.id, planItemIds),
          eq(planItems.state, 'drafting'),
        ),
      );
    return 0;
  }
}
