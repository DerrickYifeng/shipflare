import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  xContentCalendar,
  drafts,
  products,
  posts,
  xTweetMetrics,
} from '@/lib/db/schema';
import { eq, and, gte, desc, inArray } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:calendar');

/**
 * GET /api/calendar
 * List calendar items across all channels (or filtered by channel).
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const range = searchParams.get('range') ?? '7d';
  const channel = searchParams.get('channel') ?? 'all';
  const days = range === '30d' ? 30 : range === '14d' ? 14 : 7;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const conditions = [
    eq(xContentCalendar.userId, session.user.id),
    gte(xContentCalendar.scheduledAt, since),
  ];

  if (channel !== 'all') {
    conditions.push(eq(xContentCalendar.channel, channel));
  }

  const rows = await db
    .select({
      id: xContentCalendar.id,
      userId: xContentCalendar.userId,
      productId: xContentCalendar.productId,
      channel: xContentCalendar.channel,
      scheduledAt: xContentCalendar.scheduledAt,
      contentType: xContentCalendar.contentType,
      status: xContentCalendar.status,
      topic: xContentCalendar.topic,
      draftId: xContentCalendar.draftId,
      postedExternalId: xContentCalendar.postedExternalId,
      createdAt: xContentCalendar.createdAt,
      updatedAt: xContentCalendar.updatedAt,
      draftStatus: drafts.status,
      draftPreview: drafts.replyBody,
      postExternalId: posts.externalId,
      postExternalUrl: posts.externalUrl,
      postPlatform: posts.platform,
    })
    .from(xContentCalendar)
    .leftJoin(drafts, eq(xContentCalendar.draftId, drafts.id))
    .leftJoin(posts, eq(posts.draftId, xContentCalendar.draftId))
    .where(and(...conditions))
    .orderBy(desc(xContentCalendar.scheduledAt))
    .limit(100);

  // Pull the latest x_tweet_metrics sample for each posted external id so
  // the calendar can show inline engagement (likes + replies) without a
  // roundtrip to /api/analytics.
  const tweetIds = rows
    .map((r) => r.postExternalId)
    .filter((id): id is string => !!id);

  const metricsMap = new Map<
    string,
    { likes: number; replies: number; bookmarks: number }
  >();
  if (tweetIds.length > 0) {
    // Pull all samples for the tweet set in one pass and keep the latest
    // per tweet_id on the JS side — simpler than DISTINCT ON + parameter
    // binding and still one round-trip. Ordering newest-first means the
    // first occurrence wins.
    const rowsMetrics = await db
      .select({
        tweetId: xTweetMetrics.tweetId,
        likes: xTweetMetrics.likes,
        replies: xTweetMetrics.replies,
        bookmarks: xTweetMetrics.bookmarks,
        sampledAt: xTweetMetrics.sampledAt,
      })
      .from(xTweetMetrics)
      .where(
        and(
          eq(xTweetMetrics.userId, session.user.id),
          inArray(xTweetMetrics.tweetId, tweetIds),
        ),
      )
      .orderBy(desc(xTweetMetrics.sampledAt));

    for (const r of rowsMetrics) {
      if (metricsMap.has(r.tweetId)) continue;
      metricsMap.set(r.tweetId, {
        likes: r.likes,
        replies: r.replies,
        bookmarks: r.bookmarks,
      });
    }
  }

  return NextResponse.json({
    items: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      productId: r.productId,
      channel: r.channel,
      scheduledAt: r.scheduledAt,
      contentType: r.contentType,
      status: r.status,
      topic: r.topic,
      draftId: r.draftId,
      postedExternalId: r.postedExternalId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      draftPreview: r.draftPreview ?? null,
      draftStatus: r.draftStatus ?? null,
      postUrl: r.postExternalUrl ?? null,
      metrics: r.postExternalId
        ? (metricsMap.get(r.postExternalId) ?? null)
        : null,
    })),
  });
}

/**
 * POST /api/calendar
 * Create or update a calendar entry.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: {
    id?: string;
    channel?: string;
    scheduledAt?: string;
    contentType?: string;
    topic?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const validTypes = ['metric', 'educational', 'engagement', 'product', 'thread'];
  if (body.contentType && !validTypes.includes(body.contentType)) {
    return NextResponse.json(
      { error: `Invalid contentType. Must be one of: ${validTypes.join(', ')}` },
      { status: 400 },
    );
  }

  // Update existing
  if (body.id) {
    const [existing] = await db
      .select()
      .from(xContentCalendar)
      .where(
        and(
          eq(xContentCalendar.id, body.id),
          eq(xContentCalendar.userId, session.user.id),
        ),
      )
      .limit(1);

    if (!existing) {
      return NextResponse.json({ error: 'Calendar item not found' }, { status: 404 });
    }

    await db
      .update(xContentCalendar)
      .set({
        ...(body.scheduledAt ? { scheduledAt: new Date(body.scheduledAt) } : {}),
        ...(body.contentType ? { contentType: body.contentType } : {}),
        ...(body.topic !== undefined ? { topic: body.topic } : {}),
        updatedAt: new Date(),
      })
      .where(eq(xContentCalendar.id, body.id));

    return NextResponse.json({ success: true });
  }

  // Create new
  if (!body.scheduledAt || !body.contentType) {
    return NextResponse.json(
      { error: 'scheduledAt and contentType are required' },
      { status: 400 },
    );
  }

  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);

  if (!product) {
    return NextResponse.json(
      { error: 'No product configured. Complete onboarding first.' },
      { status: 400 },
    );
  }

  const [item] = await db
    .insert(xContentCalendar)
    .values({
      userId: session.user.id,
      productId: product.id,
      channel: body.channel ?? 'x',
      scheduledAt: new Date(body.scheduledAt),
      contentType: body.contentType,
      topic: body.topic ?? null,
    })
    .returning();

  log.info(`Created calendar item ${item.id} (channel: ${item.channel}) for user ${session.user.id}`);
  return NextResponse.json({ item });
}

/**
 * DELETE /api/calendar
 * Cancel a scheduled post (channel-agnostic, operates by itemId).
 */
export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { itemId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!body.itemId) {
    return NextResponse.json({ error: 'itemId is required' }, { status: 400 });
  }

  const [item] = await db
    .select()
    .from(xContentCalendar)
    .where(
      and(
        eq(xContentCalendar.id, body.itemId),
        eq(xContentCalendar.userId, session.user.id),
      ),
    )
    .limit(1);

  if (!item) {
    return NextResponse.json({ error: 'Calendar item not found' }, { status: 404 });
  }

  await db
    .delete(xContentCalendar)
    .where(
      and(
        eq(xContentCalendar.id, body.itemId),
        eq(xContentCalendar.userId, session.user.id),
      ),
    );

  log.info(`Deleted calendar item ${body.itemId} for user ${session.user.id}`);
  return NextResponse.json({ success: true });
}
