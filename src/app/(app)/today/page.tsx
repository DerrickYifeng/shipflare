import type { Metadata } from 'next';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import {
  healthScores,
  products,
  todoItems,
  drafts,
  threads,
  posts,
  userPreferences,
  xContentCalendar,
  channels,
} from '@/lib/db/schema';
import { eq, and, desc, gt, sql, count } from 'drizzle-orm';
import { TodayContent } from './today-content';

export const metadata: Metadata = { title: 'Today' };

// Today is the hot dashboard — its data (todo_items, stats) changes minute
// to minute, so we never want a cached render.
export const dynamic = 'force-dynamic';

export default async function TodayPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const userId = session.user.id;

  // Onboarding gate — no product means the user hasn't finished setup.
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);
  if (!product) redirect('/onboarding');

  // Health score — surfaced in the CompletionState footer when idle.
  const [latestScore] = await db
    .select()
    .from(healthScores)
    .where(eq(healthScores.userId, userId))
    .orderBy(desc(healthScores.calculatedAt))
    .limit(1);
  void latestScore; // Retained so future UI can surface the score beside HeaderBar.

  // First-run gate: has the user ever had any todo items?
  const [existing] = await db
    .select({ id: todoItems.id })
    .from(todoItems)
    .where(eq(todoItems.userId, userId))
    .limit(1);

  // Connected-channel gate — drives the Scan-now disabled state + FirstRun
  // branching in a single server round-trip.
  const [anyChannel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.userId, userId))
    .limit(1);

  const now = new Date();

  // Timezone for day-boundary math.
  const [prefs] = await db
    .select({ timezone: userPreferences.timezone })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  const timezone = prefs?.timezone ?? 'America/Los_Angeles';
  const yesterdayStart = getLocalDayStart(timezone, -1);
  const todayStart = getLocalDayStart(timezone, 0);

  // The same payload `/api/today` returns, so SWR hydrates without a flash.
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
      draftBody: drafts.replyBody,
      draftConfidence: drafts.confidenceScore,
      draftWhyItWorks: drafts.whyItWorks,
      draftType: drafts.draftType,
      draftPostTitle: drafts.postTitle,
      draftMedia: drafts.media,
      threadTitle: threads.title,
      threadBody: threads.body,
      threadAuthor: threads.author,
      threadUrl: threads.url,
      threadUpvotes: threads.upvotes,
      threadCommentCount: threads.commentCount,
      threadPostedAt: threads.postedAt,
      calendarContentType: xContentCalendar.contentType,
      calendarScheduledAt: xContentCalendar.scheduledAt,
    })
    .from(todoItems)
    .leftJoin(drafts, eq(todoItems.draftId, drafts.id))
    .leftJoin(threads, eq(drafts.threadId, threads.id))
    .leftJoin(xContentCalendar, eq(xContentCalendar.draftId, todoItems.draftId))
    .where(
      and(
        eq(todoItems.userId, userId),
        eq(todoItems.status, 'pending'),
        gt(todoItems.expiresAt, now),
      ),
    )
    .orderBy(
      sql`CASE ${todoItems.priority}
        WHEN 'time_sensitive' THEN 0
        WHEN 'scheduled' THEN 1
        WHEN 'optional' THEN 2
      END`,
      todoItems.createdAt,
    );

  const [{ value: publishedYesterday }] = await db
    .select({ value: count() })
    .from(posts)
    .where(
      and(
        eq(posts.userId, userId),
        sql`${posts.postedAt} >= ${yesterdayStart.toISOString()}`,
        sql`${posts.postedAt} < ${todayStart.toISOString()}`,
      ),
    );

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

  // Yesterday's top post — surfaced inside CompletionState. Ordered by
  // threadUpvotes desc as a best-effort engagement proxy; falls back to
  // most-recent when metrics are null.
  const [yesterdayTop] = await db
    .select({
      id: posts.id,
      platform: posts.platform,
      community: posts.community,
      externalUrl: posts.externalUrl,
      postedAt: posts.postedAt,
      draftType: drafts.draftType,
      draftPostTitle: drafts.postTitle,
      replyBody: drafts.replyBody,
      threadTitle: threads.title,
      threadUpvotes: threads.upvotes,
      threadCommentCount: threads.commentCount,
    })
    .from(posts)
    .leftJoin(drafts, eq(posts.draftId, drafts.id))
    .leftJoin(threads, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(posts.userId, userId),
        sql`${posts.postedAt} >= ${yesterdayStart.toISOString()}`,
        sql`${posts.postedAt} < ${todayStart.toISOString()}`,
      ),
    )
    .orderBy(desc(threads.upvotes), desc(posts.postedAt))
    .limit(1);

  // Most recent "posted" wall clock as a best-effort last-scan proxy. We
  // don't persist scan-runs server-side today; client falls back to
  // localStorage. This keeps the meta line useful on first render without
  // a new schema migration.
  const [lastPosted] = await db
    .select({ at: posts.postedAt })
    .from(posts)
    .where(eq(posts.userId, userId))
    .orderBy(desc(posts.postedAt))
    .limit(1);

  const fallbackData = {
    items,
    stats: {
      published_yesterday: publishedYesterday,
      pending_count: items.length,
      acted_today: actedToday,
    },
  };

  return (
    <TodayContent
      isFirstRun={!existing}
      hasChannel={!!anyChannel}
      fallbackData={fallbackData}
      yesterdayTop={yesterdayTop ?? null}
      lastScanAt={lastPosted?.at ?? null}
    />
  );
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
