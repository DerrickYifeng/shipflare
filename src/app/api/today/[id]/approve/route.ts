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

  // Verify ownership and status
  const [todo] = await db
    .select()
    .from(todoItems)
    .where(and(eq(todoItems.id, id), eq(todoItems.userId, userId)))
    .limit(1);

  if (!todo) {
    return NextResponse.json({ error: 'Todo not found' }, { status: 404 });
  }

  if (todo.status !== 'pending') {
    return NextResponse.json(
      { error: 'Todo already processed' },
      { status: 400 },
    );
  }

  // If linked to a draft, approve the draft and enqueue posting
  if (todo.draftId) {
    await db
      .update(drafts)
      .set({ status: 'approved', updatedAt: new Date() })
      .where(eq(drafts.id, todo.draftId));

    // Find draft's thread to determine platform
    const [draft] = await db
      .select({ threadId: drafts.threadId })
      .from(drafts)
      .where(eq(drafts.id, todo.draftId))
      .limit(1);

    if (draft) {
      const [thread] = await db
        .select({ platform: threads.platform })
        .from(threads)
        .where(eq(threads.id, draft.threadId))
        .limit(1);

      const platform = thread?.platform ?? 'reddit';

      const [channel] = await db
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(eq(channels.userId, userId), eq(channels.platform, platform)),
        )
        .limit(1);

      if (channel) {
        await enqueuePosting({
          userId,
          draftId: todo.draftId,
          channelId: channel.id,
          traceId,
        });
        log.info(`Todo ${id} approved, posting enqueued for draft ${todo.draftId}`);
      } else {
        // Don't silently swallow — the user needs to know their approval won't
        // result in a post. Roll back the draft-status change so they can
        // retry after connecting the account.
        log.warn(`Todo ${id} approve blocked: no ${platform} channel for user ${userId}`);
        await db
          .update(drafts)
          .set({ status: 'pending', updatedAt: new Date() })
          .where(eq(drafts.id, todo.draftId));
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
