import { db } from '@/lib/db';
import {
  todoItems,
  drafts,
  threads,
  xContentCalendar,
  xMonitoredTweets,
  userPreferences,
  products,
} from '@/lib/db/schema';
import { eq, and, sql, gte, lte, inArray, isNull, count } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:today:seed');

const MAX_TODO_ITEMS = 7;

/**
 * Get the current hour in a given IANA timezone.
 */
export function getLocalHour(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: timezone,
  });
  return parseInt(formatter.format(date), 10);
}

/**
 * Get the start and end of "today" in the user's local timezone.
 */
function getLocalDayBounds(
  timezone: string,
): { dayStart: Date; dayEnd: Date } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localDate = formatter.format(now); // 'YYYY-MM-DD'

  // Parse as local date boundaries in the user's timezone
  const dayStart = new Date(`${localDate}T00:00:00`);
  const dayEnd = new Date(`${localDate}T23:59:59`);

  // Convert to UTC using timezone offset
  const offsetMs = getTimezoneOffsetMs(timezone);
  return {
    dayStart: new Date(dayStart.getTime() - offsetMs),
    dayEnd: new Date(dayEnd.getTime() - offsetMs),
  };
}

function getTimezoneOffsetMs(timezone: string): number {
  const now = new Date();
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
  const localStr = now.toLocaleString('en-US', { timeZone: timezone });
  return new Date(localStr).getTime() - new Date(utcStr).getTime();
}

/**
 * Seed today's todo items for a single user.
 * Shared between the POST /api/today/seed endpoint and the BullMQ cron worker.
 * Returns the number of items created.
 */
export async function seedTodosForUser(userId: string): Promise<number> {
  // Check if user has a product (required for seeding)
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  if (!product) {
    log.debug(`No product found for user ${userId}, skipping seed`);
    return 0;
  }

  // Load user timezone
  const [prefs] = await db
    .select({ timezone: userPreferences.timezone })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  const timezone = prefs?.timezone ?? 'America/Los_Angeles';

  // Check existing pending count
  const [{ value: pendingCount }] = await db
    .select({ value: count() })
    .from(todoItems)
    .where(
      and(eq(todoItems.userId, userId), eq(todoItems.status, 'pending')),
    );

  if (pendingCount >= MAX_TODO_ITEMS) {
    log.debug(`User ${userId} already has ${pendingCount} pending todos, skipping`);
    return 0;
  }

  const remaining = MAX_TODO_ITEMS - pendingCount;
  const { dayStart, dayEnd } = getLocalDayBounds(timezone);
  const newItems: (typeof todoItems.$inferInsert)[] = [];

  // 1. Calendar: posts scheduled for today that need approval
  const calendarItems = await db
    .select({
      id: xContentCalendar.id,
      draftId: xContentCalendar.draftId,
      scheduledAt: xContentCalendar.scheduledAt,
      contentType: xContentCalendar.contentType,
      topic: xContentCalendar.topic,
    })
    .from(xContentCalendar)
    .where(
      and(
        eq(xContentCalendar.userId, userId),
        gte(xContentCalendar.scheduledAt, dayStart),
        lte(xContentCalendar.scheduledAt, dayEnd),
        inArray(xContentCalendar.status, ['scheduled', 'draft_created']),
      ),
    );

  for (const cal of calendarItems) {
    if (newItems.length >= remaining) break;

    // Skip if a todo already exists for this draft
    if (cal.draftId) {
      const [existing] = await db
        .select({ id: todoItems.id })
        .from(todoItems)
        .where(
          and(
            eq(todoItems.userId, userId),
            eq(todoItems.draftId, cal.draftId),
          ),
        )
        .limit(1);
      if (existing) continue;
    }

    newItems.push({
      userId,
      draftId: cal.draftId,
      todoType: 'approve_post',
      source: 'calendar',
      priority: 'scheduled',
      status: 'pending',
      title: cal.topic
        ? `${cal.contentType} post: ${cal.topic}`
        : `Scheduled ${cal.contentType} post`,
      platform: 'x',
      scheduledFor: cal.scheduledAt,
      expiresAt: dayEnd,
    });
  }

  // 2. Discovery: top relevant threads with pending drafts
  const discoveryDrafts = await db
    .select({
      draftId: drafts.id,
      draftType: drafts.draftType,
      replyBody: drafts.replyBody,
      confidenceScore: drafts.confidenceScore,
      threadTitle: threads.title,
      threadCommunity: threads.community,
      threadUrl: threads.url,
      threadPlatform: threads.platform,
      threadUpvotes: threads.upvotes,
      threadDiscoveredAt: threads.discoveredAt,
      engagementDepth: drafts.engagementDepth,
    })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .leftJoin(
      xMonitoredTweets,
      and(
        eq(threads.externalId, xMonitoredTweets.tweetId),
        eq(xMonitoredTweets.userId, userId),
      ),
    )
    .leftJoin(xContentCalendar, eq(xContentCalendar.draftId, drafts.id))
    .where(
      and(
        eq(drafts.userId, userId),
        eq(drafts.status, 'pending'),
        eq(drafts.engagementDepth, 0),
        isNull(xMonitoredTweets.id), // not a monitor tweet
        isNull(xContentCalendar.id), // not a calendar item
      ),
    )
    .orderBy(sql`${drafts.confidenceScore} DESC`)
    .limit(3);

  const now = new Date();

  for (const d of discoveryDrafts) {
    if (newItems.length >= remaining) break;

    // Skip if todo already exists for this draft
    const [existing] = await db
      .select({ id: todoItems.id })
      .from(todoItems)
      .where(
        and(eq(todoItems.userId, userId), eq(todoItems.draftId, d.draftId)),
      )
      .limit(1);
    if (existing) continue;

    // Priority classification
    const threadAgeHours =
      (now.getTime() - d.threadDiscoveredAt.getTime()) / (1000 * 60 * 60);
    const isTimeSensitive =
      threadAgeHours < 4 || (d.threadUpvotes ?? 0) > 50;

    newItems.push({
      userId,
      draftId: d.draftId,
      todoType: d.draftType === 'reply' ? 'reply_thread' : 'approve_post',
      source: 'discovery',
      priority: isTimeSensitive
        ? 'time_sensitive'
        : d.confidenceScore < 0.7
          ? 'optional'
          : 'scheduled',
      status: 'pending',
      title: d.threadTitle.length > 100
        ? d.threadTitle.slice(0, 97) + '...'
        : d.threadTitle,
      platform: d.threadPlatform ?? 'reddit',
      community: d.threadCommunity,
      externalUrl: d.threadUrl,
      confidence: d.confidenceScore,
      expiresAt: dayEnd,
    });
  }

  // 3. Engagement: replies/mentions needing response
  const engagementDrafts = await db
    .select({
      draftId: drafts.id,
      replyBody: drafts.replyBody,
      confidenceScore: drafts.confidenceScore,
      threadTitle: threads.title,
      threadCommunity: threads.community,
      threadUrl: threads.url,
      threadPlatform: threads.platform,
    })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(drafts.userId, userId),
        eq(drafts.status, 'pending'),
        sql`(${drafts.engagementDepth} > 0 OR (${threads.community} LIKE '@%' AND ${threads.platform} = 'x'))`,
      ),
    )
    .orderBy(sql`${drafts.confidenceScore} DESC`)
    .limit(3);

  for (const e of engagementDrafts) {
    if (newItems.length >= remaining) break;

    // Skip if todo already exists for this draft
    const [existing] = await db
      .select({ id: todoItems.id })
      .from(todoItems)
      .where(
        and(eq(todoItems.userId, userId), eq(todoItems.draftId, e.draftId)),
      )
      .limit(1);
    if (existing) continue;

    newItems.push({
      userId,
      draftId: e.draftId,
      todoType: 'respond_engagement',
      source: 'engagement',
      priority: 'time_sensitive',
      status: 'pending',
      title: e.threadTitle.length > 100
        ? e.threadTitle.slice(0, 97) + '...'
        : e.threadTitle,
      platform: e.threadPlatform ?? 'x',
      community: e.threadCommunity,
      externalUrl: e.threadUrl,
      confidence: e.confidenceScore,
      expiresAt: new Date(now.getTime() + 4 * 60 * 60 * 1000), // 4 hours
    });
  }

  if (newItems.length === 0) {
    log.debug(`No items to seed for user ${userId}`);
    return 0;
  }

  await db.insert(todoItems).values(newItems).onConflictDoNothing();

  log.info(`Seeded ${newItems.length} todo items for user ${userId}`);
  return newItems.length;
}
