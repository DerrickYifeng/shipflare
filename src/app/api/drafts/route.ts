import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts, threads, channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { enqueuePosting } from '@/lib/queue';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results = await db
    .select({
      id: drafts.id,
      threadId: drafts.threadId,
      replyBody: drafts.replyBody,
      confidenceScore: drafts.confidenceScore,
      whyItWorks: drafts.whyItWorks,
      ftcDisclosure: drafts.ftcDisclosure,
      status: drafts.status,
      createdAt: drafts.createdAt,
      threadTitle: threads.title,
      threadSubreddit: threads.subreddit,
      threadUrl: threads.url,
    })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(and(eq(drafts.userId, session.user.id), eq(drafts.status, 'pending')))
    .orderBy(drafts.createdAt);

  return NextResponse.json({
    drafts: results.map((r) => ({
      id: r.id,
      threadId: r.threadId,
      replyBody: r.replyBody,
      confidenceScore: r.confidenceScore,
      whyItWorks: r.whyItWorks,
      ftcDisclosure: r.ftcDisclosure,
      status: r.status,
      createdAt: r.createdAt,
      thread: {
        title: r.threadTitle,
        subreddit: r.threadSubreddit,
        url: r.threadUrl,
      },
    })),
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { draftId, action } = await request.json();
  if (!draftId || !['approve', 'skip'].includes(action)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  // Verify draft belongs to user
  const [draft] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, session.user.id)))
    .limit(1);

  if (!draft) {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  }

  if (action === 'approve') {
    await db
      .update(drafts)
      .set({ status: 'approved', updatedAt: new Date() })
      .where(eq(drafts.id, draftId));

    // Find user's Reddit channel for posting
    const [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.userId, session.user.id), eq(channels.platform, 'reddit')))
      .limit(1);

    if (channel) {
      await enqueuePosting({
        userId: session.user.id,
        draftId,
        channelId: channel.id,
      });
    }
  } else {
    await db
      .update(drafts)
      .set({ status: 'skipped', updatedAt: new Date() })
      .where(eq(drafts.id, draftId));
  }

  return NextResponse.json({ success: true });
}
