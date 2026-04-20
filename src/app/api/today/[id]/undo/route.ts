import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { todoItems, drafts } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { postingQueue } from '@/lib/queue';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:today:undo');

/**
 * Undo an approved todo.
 *
 * The approve handler schedules posting via `enqueuePosting`, which adds a
 * BullMQ posting job with a random 0–30 min delay. As long as that job is
 * still in the `delayed` state we can `job.remove()` it, revert the draft
 * back to `'pending'`, and flip the todo back to `'pending'`. Once the
 * worker has picked the job up (active/completed/failed) the post has
 * already been attempted and we cannot roll it back.
 *
 * Returns:
 *   200 { success: true, reverted: true }   — delayed job removed, todo reverted
 *   409 { success: false, reason: 'already_posted' } — job already processing/processed
 *   404 { success: false, reason: 'no_job' } — no posting job found for this draft
 *   404 { error: 'Todo not found' }         — todo missing or not owned by user
 *   400 { error: ... }                      — invalid id or not undo-able state
 *   401 { error: 'Unauthorized' }           — no session
 */
const idSchema = z.string().uuid();

const UNDOABLE_JOB_STATES: ReadonlySet<string> = new Set(['delayed', 'waiting', 'prioritized']);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { log, traceId } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const { id: rawId } = await params;
  const parsed = idSchema.safeParse(rawId);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid todo id', traceId },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }
  const id = parsed.data;

  try {
    // Ownership + current state + associated draftId.
    const [row] = await db
      .select({
        status: todoItems.status,
        draftId: todoItems.draftId,
      })
      .from(todoItems)
      .where(and(eq(todoItems.id, id), eq(todoItems.userId, userId)))
      .limit(1);

    if (!row) {
      return NextResponse.json(
        { error: 'Todo not found', traceId },
        { status: 404, headers: { 'x-trace-id': traceId } },
      );
    }

    // Only `approved` todos can be undone. `pending` is already the
    // target state — treat as a no-op 200 so duplicate undo clicks are
    // idempotent. `skipped`/`expired` aren't undo-able here.
    if (row.status === 'pending') {
      return NextResponse.json(
        { success: true, reverted: false, reason: 'already_pending', traceId },
        { headers: { 'x-trace-id': traceId } },
      );
    }
    if (row.status !== 'approved') {
      return NextResponse.json(
        {
          success: false,
          reason: 'not_undoable',
          status: row.status,
          traceId,
        },
        { status: 400, headers: { 'x-trace-id': traceId } },
      );
    }

    // If the todo has no draft linked, there is no posting job to cancel.
    // Flip the todo back to pending so the card reappears in the queue.
    if (!row.draftId) {
      await db
        .update(todoItems)
        .set({ status: 'pending', actedAt: null })
        .where(and(eq(todoItems.id, id), eq(todoItems.userId, userId)));
      log.info(`Todo ${id} reverted (no draft, no job to cancel)`);
      return NextResponse.json(
        { success: true, reverted: true, cancelledJob: false, traceId },
        { headers: { 'x-trace-id': traceId } },
      );
    }

    // Find the posting job for this draft. `enqueuePosting` doesn't set an
    // explicit jobId on the posting queue, so we scan delayed/waiting jobs
    // and match by draftId + userId (both are on the payload). The posting
    // queue is small — only user-approved drafts awaiting their random 0-30
    // min posting window — so a getJobs sweep is acceptable.
    const candidates = await postingQueue.getJobs([
      'delayed',
      'waiting',
      'active',
      'completed',
      'failed',
      'prioritized',
    ]);
    const match = candidates.find(
      (j) =>
        j &&
        j.data &&
        j.data.draftId === row.draftId &&
        j.data.userId === userId,
    );

    if (!match) {
      // No posting job at all → safest assumption is that the post already
      // ran and was cleaned up. Surface as 404 so the client can show an
      // appropriate message.
      log.warn(`Undo requested for todo ${id} but no posting job found for draft ${row.draftId}`);
      return NextResponse.json(
        { success: false, reason: 'no_job', traceId },
        { status: 404, headers: { 'x-trace-id': traceId } },
      );
    }

    const state = await match.getState();

    if (!UNDOABLE_JOB_STATES.has(state)) {
      log.info(
        `Undo rejected for todo ${id}: posting job in non-cancellable state ${state}`,
      );
      return NextResponse.json(
        { success: false, reason: 'already_posted', state, traceId },
        { status: 409, headers: { 'x-trace-id': traceId } },
      );
    }

    // Cancel the delayed job. BullMQ's `job.remove()` is safe on delayed/
    // waiting jobs — it atomically removes the job from Redis so the worker
    // never picks it up.
    await match.remove();

    // Revert draft back to pending so the user can re-approve later.
    await db
      .update(drafts)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(drafts.id, row.draftId));

    // Flip the todo back to pending + clear actedAt so it reappears in the
    // Today queue exactly where it was.
    await db
      .update(todoItems)
      .set({ status: 'pending', actedAt: null })
      .where(and(eq(todoItems.id, id), eq(todoItems.userId, userId)));

    log.info(`Todo ${id} undone, posting job ${match.id ?? '?'} removed`);

    return NextResponse.json(
      { success: true, reverted: true, cancelledJob: true, traceId },
      { headers: { 'x-trace-id': traceId } },
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    log.error(`Undo failed for todo ${id}: ${message}`);
    return NextResponse.json(
      { error: 'Undo failed', traceId },
      { status: 500, headers: { 'x-trace-id': traceId } },
    );
  }
}
