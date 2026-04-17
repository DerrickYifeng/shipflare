import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts, channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { enqueuePosting } from '@/lib/queue';
import { createLogger, loggerForRequest } from '@/lib/logger';
import {
  recordPipelineEvent,
  recordThreadFeedback,
} from '@/lib/pipeline-events';

const baseLog = createLogger('api:discovery:approve');

/**
 * POST /api/discovery/approve
 * Approve or skip a discovery draft.
 */
export async function POST(request: NextRequest) {
  const { log, traceId } = loggerForRequest(baseLog, request);
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { draftId?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { draftId, action } = body;

  if (!draftId || !action || !['approve', 'skip'].includes(action)) {
    return NextResponse.json(
      { error: 'draftId and action (approve|skip) are required' },
      { status: 400 },
    );
  }

  // Verify draft belongs to user
  const [draft] = await db
    .select({
      id: drafts.id,
      status: drafts.status,
      threadId: drafts.threadId,
    })
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, session.user.id)))
    .limit(1);

  if (!draft) {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  }

  if (action === 'skip') {
    await db
      .update(drafts)
      .set({ status: 'skipped' })
      .where(eq(drafts.id, draftId));

    await recordThreadFeedback({
      userId: session.user.id,
      threadId: draft.threadId,
      userAction: 'skip',
    });

    log.info(`Draft ${draftId} skipped`);
    return NextResponse.json({ success: true, status: 'skipped' });
  }

  // Find the user's channel for posting
  // TODO: determine platform from the thread record for multi-platform support
  const [channel] = await db
    .select({ id: channels.id, platform: channels.platform })
    .from(channels)
    .where(eq(channels.userId, session.user.id))
    .limit(1);

  if (!channel) {
    // Don't claim success when the post can't actually go out. Keep the draft
    // status at its pre-approve value so the user can retry after connecting
    // an account.
    log.warn(`Draft ${draftId} approve blocked: no channel for user ${session.user.id}`);
    return NextResponse.json(
      {
        error: 'Connect an account (Reddit or X) to publish approved drafts.',
        code: 'NO_CHANNEL',
      },
      { status: 409 },
    );
  }

  // Approve: update status and enqueue posting
  await db
    .update(drafts)
    .set({ status: 'approved' })
    .where(eq(drafts.id, draftId));

  await enqueuePosting({
    userId: session.user.id,
    draftId,
    channelId: channel.id,
    traceId,
  });

  // Telemetry: stage='approved' + thread_feedback label for the discovery
  // optimization loop.
  await recordPipelineEvent({
    userId: session.user.id,
    threadId: draft.threadId,
    draftId,
    stage: 'approved',
    metadata: { platform: channel.platform, autoApproved: false },
  });
  await recordThreadFeedback({
    userId: session.user.id,
    threadId: draft.threadId,
    userAction: 'approve',
  });

  log.info(`Draft ${draftId} approved, posting enqueued`);

  return NextResponse.json(
    { success: true, status: 'approved', traceId },
    { headers: { 'x-trace-id': traceId } },
  );
}
