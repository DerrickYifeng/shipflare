import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts, channels, threads } from '@/lib/db/schema';
import { enqueuePosting } from '@/lib/queue';
import { paramsSchema, findOwnedPlanItem } from '@/app/api/plan-item/[id]/_helpers';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:today:post-now');

/**
 * POST /api/today/:id/post-now
 *
 * Re-enqueue an already-approved draft with delayMs=0, bypassing the
 * pacer's spacing/quiet-hours delay. The original delayed BullMQ job
 * stays in the queue but is harmless: when it eventually fires, the
 * worker checks `drafts.status` and aborts because the draft will have
 * already moved to `'posted'`.
 *
 * Resolves both id types (plan_item.id or drafts.id), same as the
 * approve endpoint.
 *
 *   200 { success: true }
 *   400 invalid_id
 *   401 unauthorized
 *   404 not_found
 *   409 not_approved (draft must be in 'approved' status)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { log, traceId } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: rawId } = await params;
  const parsed = paramsSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_id' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }

  // Resolve to a draft id. Try plan_item lookup first; fall back to direct
  // draft id (reply-card path).
  let draftId: string | null = null;
  const planRow = await findOwnedPlanItem(parsed.data.id, session.user.id);
  if (planRow) {
    draftId = await findDraftIdForPlanItemAnyStatus(planRow.id);
  } else {
    draftId = parsed.data.id;
  }

  if (!draftId) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }

  // Load the draft with its channel for enqueue.
  const [draftRow] = await db
    .select({
      draftId: drafts.id,
      draftUserId: drafts.userId,
      draftStatus: drafts.status,
      threadPlatform: threads.platform,
    })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, session.user.id)))
    .limit(1);

  if (!draftRow) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }

  if (draftRow.draftStatus !== 'approved') {
    return NextResponse.json(
      { error: 'not_approved', current: draftRow.draftStatus },
      { status: 409, headers: { 'x-trace-id': traceId } },
    );
  }

  const [channelRow] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.userId, session.user.id),
        eq(channels.platform, draftRow.threadPlatform),
      ),
    )
    .limit(1);

  if (!channelRow) {
    return NextResponse.json(
      { error: 'channel_not_found' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }

  await enqueuePosting(
    {
      userId: session.user.id,
      draftId,
      channelId: channelRow.id,
      mode: 'direct',
      traceId,
    },
    { delayMs: 0 },
  );

  log.info(`post-now enqueued for draft ${draftId} (bypassing pacer delay)`);
  return NextResponse.json(
    { success: true },
    { headers: { 'x-trace-id': traceId } },
  );
}

/**
 * Look up the draft linked to a plan_item without filtering on status.
 * (`findDraftIdForPlanItem` filters status='pending', which excludes the
 * 'approved' rows we want here.)
 */
async function findDraftIdForPlanItemAnyStatus(
  planItemId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(eq(drafts.planItemId, planItemId))
    .limit(1);
  return row?.id ?? null;
}

