import type { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { planItems } from '@/lib/db/schema';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { PlanExecuteJobData } from '@/lib/queue/plan-execute';
import {
  dispatchPlanItem,
  type PlanItemKind,
} from '@/lib/plan-execute-dispatch';
import {
  canTransition,
  transition,
  type PlanItemState,
  type PlanItemUserAction,
} from '@/lib/plan-state';
import { ensureTeamExists } from '@/lib/team-provisioner';
import { enqueueTeamRun } from '@/lib/queue/team-run';
import { createAutomationConversation } from '@/lib/team-conversation-helpers';

const baseLog = createLogger('worker:plan-execute');

/**
 * Channels that route draft-phase content_post jobs to the post-writer
 * team-run instead of the legacy dispatch table. The writer is the same
 * agent for both platforms — `plan_items.channel` rides through to
 * `draft_post`, which picks the right platform-specific drafting prompt.
 */
const WRITER_CHANNELS = new Set<string>(['x', 'reddit']);
const POST_WRITER_AGENT = 'post-writer';

function writerAgentFor(
  kind: PlanItemKind,
  channel: string | null,
): string | null {
  if (kind !== 'content_post') return null;
  if (!channel) return null;
  return WRITER_CHANNELS.has(channel) ? POST_WRITER_AGENT : null;
}

/**
 * Plan-execute dispatcher.
 *
 * Two paths:
 *
 * 1) **Writer team-run (Phase E Day 3)** — for `phase='draft'` +
 *    `kind='content_post'` + `channel IN ('x','reddit')`. The processor
 *    enqueues a team-run with the matching writer AGENT.md; the writer's
 *    `draft_post` tool UPDATEs `plan_items.output.draft_body` and flips
 *    `state` to `'drafted'`. Fire-and-forget from the processor's POV:
 *    it returns as soon as the enqueue succeeds.
 *
 * 2) **Legacy state-machine stub** — for every other (kind, phase)
 *    combination. Runs the state transitions from the existing dispatch
 *    table without invoking a skill. The remaining keep-until-Phase-E
 *    skills (posting, draft-review, etc.) still arrive here; a future
 *    Phase E/F migration will route them through writer/reply team-runs
 *    too.
 *
 * State transitions for the legacy path:
 *  - phase='draft' + state='planned' → moves planned → drafted
 *  - phase='execute' + state IN ('approved','planned'+auto) → moves
 *    planned/approved → executing → completed
 *
 * Any other combination is treated as a stale job and no-ops loudly. The
 * job succeeds so BullMQ doesn't retry into a dead end.
 *
 * All state changes route through `transition()` so invalid moves throw
 * InvalidTransitionError and surface in the DLQ.
 */
export async function processPlanExecute(
  job: Job<PlanExecuteJobData>,
): Promise<void> {
  const log = loggerForJob(baseLog, job);
  const { planItemId, phase } = job.data;

  const [row] = await db
    .select({
      id: planItems.id,
      userId: planItems.userId,
      productId: planItems.productId,
      kind: planItems.kind,
      state: planItems.state,
      userAction: planItems.userAction,
      channel: planItems.channel,
      skillName: planItems.skillName,
    })
    .from(planItems)
    .where(eq(planItems.id, planItemId))
    .limit(1);

  if (!row) {
    log.warn(`plan_item ${planItemId} not found — dropping stale job`);
    return;
  }

  const current: RowLike = {
    id: row.id,
    state: row.state as PlanItemState,
    userAction: row.userAction as PlanItemUserAction,
  };

  // ------------------------------------------------------------------
  // Writer team-run path (content_post + x/reddit, draft phase only)
  // ------------------------------------------------------------------
  const writerAgent =
    phase === 'draft'
      ? writerAgentFor(row.kind as PlanItemKind, row.channel)
      : null;

  if (writerAgent) {
    if (!canTransition(current.state, 'drafted')) {
      log.warn(
        `plan_item ${planItemId}: draft phase fired but state is ${current.state} (expected planned) — skipping`,
      );
      return;
    }

    try {
      const { teamId, memberIds } = await ensureTeamExists(
        row.userId,
        row.productId,
      );
      const goal =
        `Spawn ${writerAgent} via Task to draft plan_item ${planItemId} (channel=${row.channel}). ` +
        `The writer reads the plan_item, calls draft_post to generate + persist the body, ` +
        `and flips the plan_item state to 'drafted'. Don't call draft_post yourself — ` +
        `delegate to the writer and return its summary.`;
      const draftConvId = await createAutomationConversation(teamId, 'draft_post');
      await enqueueTeamRun({
        teamId,
        trigger: 'draft_post',
        goal,
        rootMemberId: memberIds.coordinator,
        conversationId: draftConvId,
      });
      log.info(
        `plan_item ${planItemId}: draft phase → enqueued team-run agent=${writerAgent} channel=${row.channel}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        `plan_item ${planItemId}: draft phase writer enqueue failed: ${message}`,
      );
      await writeState(current, 'failed');
    }
    return;
  }

  // ------------------------------------------------------------------
  // Legacy dispatch-table path
  // ------------------------------------------------------------------
  const route = dispatchPlanItem({
    kind: row.kind as PlanItemKind,
    channel: row.channel,
    skillName: row.skillName,
  });

  if (!route) {
    log.error(
      `plan_item ${planItemId}: no dispatch route for kind=${row.kind} channel=${row.channel ?? 'null'} — failing`,
    );
    await writeState(current, 'failed');
    return;
  }

  if (phase === 'draft') {
    if (!canTransition(current.state, 'drafted')) {
      log.warn(
        `plan_item ${planItemId}: draft phase fired but state is ${current.state} (expected planned) — skipping`,
      );
      return;
    }

    const skillName = route.draftSkill ?? row.skillName;
    if (!skillName) {
      log.error(
        `plan_item ${planItemId}: draft phase requested but no skill registered for kind=${row.kind}`,
      );
      await writeState(current, 'failed');
      return;
    }

    log.info(
      `plan_item ${planItemId}: draft phase → skill=${skillName} (legacy stub: state transition only)`,
    );
    await writeState(current, 'drafted');
    return;
  }

  if (phase === 'execute') {
    if (!canTransition(current.state, 'executing')) {
      log.warn(
        `plan_item ${planItemId}: execute phase fired but state is ${current.state} — skipping`,
      );
      return;
    }

    const skillName = route.executeSkill ?? row.skillName;
    if (!skillName) {
      log.info(
        `plan_item ${planItemId}: execute phase for kind=${row.kind} has no skill registered — treating as manual-completion`,
      );
      const afterExecuting = await writeState(current, 'executing');
      await writeState(afterExecuting, 'completed');
      return;
    }

    log.info(
      `plan_item ${planItemId}: execute phase → skill=${skillName} (legacy stub: state transition only)`,
    );
    const afterExecuting = await writeState(current, 'executing');
    await writeState(afterExecuting, 'completed');
    return;
  }

  log.error(
    `plan_item ${planItemId}: unknown phase "${phase}" — dropping job`,
  );
}

/**
 * Validate via the state machine (throws on illegal move), then UPDATE
 * the row. Returns the post-transition row object so the caller can
 * chain `writeState()` for multi-step transitions without re-selecting.
 */
interface RowLike {
  id: string;
  state: PlanItemState;
  userAction: PlanItemUserAction;
}

async function writeState(
  current: RowLike,
  to: PlanItemState,
): Promise<RowLike> {
  const next = transition(current, to);
  await db
    .update(planItems)
    .set({ state: to, updatedAt: sql`now()` })
    .where(eq(planItems.id, current.id));
  return next;
}
