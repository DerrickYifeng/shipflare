import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { todoItems, drafts, threads, posts, userPreferences, xContentCalendar } from '@/lib/db/schema';
import { eq, and, lte, sql, count } from 'drizzle-orm';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const now = new Date();

  // Expire stale items
  await db
    .update(todoItems)
    .set({ status: 'expired' })
    .where(
      and(
        eq(todoItems.userId, userId),
        eq(todoItems.status, 'pending'),
        lte(todoItems.expiresAt, now),
      ),
    );

  // Fetch pending items with joined draft, thread, and calendar context
  const items = await db
    .select({
      id: todoItems.id,
      draftId: todoItems.draftId,
      todoType: todoItems.todoType,
      source: todoItems.source,
      priority: todoItems.priority,
      status: todoItems.status,
      title: todoItems.title,
      platform: todoItems.platform,
      community: todoItems.community,
      externalUrl: todoItems.externalUrl,
      confidence: todoItems.confidence,
      scheduledFor: todoItems.scheduledFor,
      expiresAt: todoItems.expiresAt,
      createdAt: todoItems.createdAt,
      // Joined draft fields
      draftBody: drafts.replyBody,
      draftConfidence: drafts.confidenceScore,
      draftWhyItWorks: drafts.whyItWorks,
      draftType: drafts.draftType,
      draftPostTitle: drafts.postTitle,
      draftMedia: drafts.media,
      // Joined thread fields (original content being replied to)
      threadTitle: threads.title,
      threadBody: threads.body,
      threadAuthor: threads.author,
      threadUrl: threads.url,
      threadUpvotes: threads.upvotes,
      threadCommentCount: threads.commentCount,
      threadPostedAt: threads.postedAt,
      // Joined calendar fields
      calendarContentType: xContentCalendar.contentType,
      calendarScheduledAt: xContentCalendar.scheduledAt,
    })
    .from(todoItems)
    .leftJoin(drafts, eq(todoItems.draftId, drafts.id))
    .leftJoin(threads, eq(drafts.threadId, threads.id))
    .leftJoin(xContentCalendar, eq(xContentCalendar.draftId, todoItems.draftId))
    .where(and(eq(todoItems.userId, userId), eq(todoItems.status, 'pending')))
    .orderBy(
      sql`CASE ${todoItems.priority}
        WHEN 'time_sensitive' THEN 0
        WHEN 'scheduled' THEN 1
        WHEN 'optional' THEN 2
      END`,
      todoItems.createdAt,
    );

  // Load user timezone for date calculations
  const [prefs] = await db
    .select({ timezone: userPreferences.timezone })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  const timezone = prefs?.timezone ?? 'America/Los_Angeles';

  // Compute yesterday boundaries in user's timezone
  const yesterdayStart = getLocalDayStart(timezone, -1);
  const yesterdayEnd = getLocalDayStart(timezone, 0);

  // Stats: published yesterday
  const [{ value: publishedYesterday }] = await db
    .select({ value: count() })
    .from(posts)
    .where(
      and(
        eq(posts.userId, userId),
        sql`${posts.postedAt} >= ${yesterdayStart.toISOString()}`,
        sql`${posts.postedAt} < ${yesterdayEnd.toISOString()}`,
      ),
    );

  // Stats: acted today (approved + skipped with actedAt today)
  const todayStart = getLocalDayStart(timezone, 0);
  const [{ value: actedToday }] = await db
    .select({ value: count() })
    .from(todoItems)
    .where(
      and(
        eq(todoItems.userId, userId),
        sql`${todoItems.status} IN ('approved', 'skipped')`,
        sql`${todoItems.actedAt} >= ${todayStart.toISOString()}`,
      ),
    );

  return NextResponse.json({
    items,
    stats: {
      published_yesterday: publishedYesterday,
      pending_count: items.length,
      acted_today: actedToday,
    },
  });
}

function getLocalDayStart(timezone: string, dayOffset: number): Date {
  const now = new Date();
  const adjusted = new Date(now.getTime() + dayOffset * 86400000);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localDate = formatter.format(adjusted);
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
  const localStr = now.toLocaleString('en-US', { timeZone: timezone });
  const offsetMs = new Date(localStr).getTime() - new Date(utcStr).getTime();
  return new Date(new Date(`${localDate}T00:00:00`).getTime() - offsetMs);
}
