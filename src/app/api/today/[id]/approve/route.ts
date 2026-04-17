import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { todoItems, drafts, threads, channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { enqueuePosting } from '@/lib/queue';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:today:approve');

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { log, traceId } = loggerForRequest(baseLog, request);
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const userId = session.user.id;

  // Single-round-trip ownership + draft + thread + channel resolution.
  // LEFT JOINs handle the legitimate "todo with no draft" case (after H6b
  // the draft_id FK ON DELETE SET NULL means a todo can outlive its draft);
  // INNER would silently drop those valid rows.
  const [row] = await db
    .select({
      todoStatus: todoItems.status,
      draftId: drafts.id,
      threadPlatform: threads.platform,
      channelId: channels.id,
    })
    .from(todoItems)
    .leftJoin(drafts, eq(todoItems.draftId, drafts.id))
    .leftJoin(threads, eq(drafts.threadId, threads.id))
    .leftJoin(
      channels,
      and(eq(channels.userId, userId), eq(channels.platform, threads.platform)),
    )
    .where(and(eq(todoItems.id, id), eq(todoItems.userId, userId)))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: 'Todo not found' }, { status: 404 });
  }

  if (row.todoStatus !== 'pending') {
    return NextResponse.json(
      { error: 'Todo already processed' },
      { status: 400 },
    );
  }

  // If linked to a draft, approve the draft and enqueue posting.
  // drafts.threadId is NOT NULL and threads.platform is NOT NULL, so when
  // row.draftId is present row.threadPlatform is guaranteed non-null.
  if (row.draftId) {
    const draftId = row.draftId;
    const platform = row.threadPlatform ?? 'reddit';

    await db
      .update(drafts)
      .set({ status: 'approved', updatedAt: new Date() })
      .where(eq(drafts.id, draftId));

    if (row.channelId) {
      await enqueuePosting({
        userId,
        draftId,
        channelId: row.channelId,
        traceId,
      });
      log.info(`Todo ${id} approved, posting enqueued for draft ${draftId}`);
    } else {
      // Don't silently swallow — the user needs to know their approval won't
      // result in a post. Roll back the draft-status change so they can
      // retry after connecting the account.
      log.warn(`Todo ${id} approve blocked: no ${platform} channel for user ${userId}`);
      await db
        .update(drafts)
        .set({ status: 'pending', updatedAt: new Date() })
        .where(eq(drafts.id, draftId));
      return NextResponse.json(
        {
          error: `Connect your ${platform === 'x' ? 'X' : platform} account to publish this post.`,
          code: 'NO_CHANNEL',
          platform,
        },
        { status: 409 },
      );
    }
  }

  // Mark todo as approved
  await db
    .update(todoItems)
    .set({ status: 'approved', actedAt: new Date() })
    .where(eq(todoItems.id, id));

  return NextResponse.json(
    { success: true, traceId },
    { headers: { 'x-trace-id': traceId } },
  );
}
