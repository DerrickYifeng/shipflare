import { NextResponse } from 'next/server';
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { activityEvents, drafts, planItems, threads } from '@/lib/db/schema';
import { PLATFORMS } from '@/lib/platform-config';
import { buildXIntentUrl } from '@/lib/x-intent-url';

// Briefing → History tab. Surfaces (a) reply drafts the founder has
// already acted on within the trailing window, AND (b) completed
// content_post plan_items in the same window. Both project into the
// same BriefingHistoryItem shape so <ReplyCard /> can render either
// without branching on the data source.

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_WINDOW_DAYS = 7;

interface TodoMedia {
  url: string;
  type: 'image' | 'gif' | 'video';
  alt?: string;
}

export interface BriefingHistoryItem {
  id: string;
  draftId: string;
  todoType: 'reply_thread';
  source: 'discovery';
  priority: 'time_sensitive';
  /** Server-side draft status — tells the card whether to render
   *  "Open X again" (handed_off) or a read-only posted state (posted). */
  status: 'handed_off' | 'posted';
  planState: null;
  xIntentUrl: string | null;
  title: string;
  platform: string;
  community: string | null;
  externalUrl: string | null;
  confidence: number | null;
  scheduledFor: null;
  /** Server-side `updated_at` of the underlying draft (or `completed_at`
   *  for posted plan_items) — when the user acted. */
  expiresAt: string;
  createdAt: string;
  draftBody: string | null;
  draftConfidence: number | null;
  draftWhyItWorks: string | null;
  draftType: 'reply' | 'original_post';
  draftPostTitle: string | null;
  draftMedia: TodoMedia[] | null;
  threadTitle: string | null;
  threadBody: string | null;
  threadAuthor: string | null;
  threadUrl: string | null;
  threadUpvotes: number | null;
  threadCommentCount: number | null;
  threadPostedAt: string | null;
  threadDiscoveredAt: string | null;
  threadLikesCount: number | null;
  threadRepostsCount: number | null;
  threadRepliesCount: number | null;
  threadViewsCount: number | null;
  threadIsRepost: boolean;
  threadOriginalUrl: string | null;
  threadOriginalAuthorUsername: string | null;
  threadSurfacedVia: string[] | null;
  calendarContentType: null;
  calendarScheduledAt: null;
}

/** Extract `draft_body` from `plan_items.output` without trusting its shape. */
function readDraftBody(output: unknown): string | null {
  if (output === null || typeof output !== 'object') return null;
  const value = (output as Record<string, unknown>).draft_body;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;
  const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * DAY_MS);

  const rows = await db
    .select({
      draftId: drafts.id,
      draftStatus: drafts.status,
      draftType: drafts.draftType,
      postTitle: drafts.postTitle,
      replyBody: drafts.replyBody,
      confidenceScore: drafts.confidenceScore,
      whyItWorks: drafts.whyItWorks,
      media: drafts.media,
      draftCreatedAt: drafts.createdAt,
      draftUpdatedAt: drafts.updatedAt,
      threadId: threads.id,
      threadPlatform: threads.platform,
      threadExternalId: threads.externalId,
      threadCommunity: threads.community,
      threadTitle: threads.title,
      threadBody: threads.body,
      threadAuthor: threads.author,
      threadUrl: threads.url,
      threadUpvotes: threads.upvotes,
      threadCommentCount: threads.commentCount,
      threadPostedAt: threads.postedAt,
      threadDiscoveredAt: threads.discoveredAt,
      threadLikesCount: threads.likesCount,
      threadRepostsCount: threads.repostsCount,
      threadRepliesCount: threads.repliesCount,
      threadViewsCount: threads.viewsCount,
      threadIsRepost: threads.isRepost,
      threadOriginalUrl: threads.originalUrl,
      threadOriginalAuthorUsername: threads.originalAuthorUsername,
      threadSurfacedVia: threads.surfacedVia,
    })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(drafts.userId, userId),
        inArray(drafts.status, ['handed_off', 'posted']),
        gte(drafts.updatedAt, since),
      ),
    )
    .orderBy(desc(drafts.updatedAt));

  // Completed content_post plan_items in the same trailing window.
  // These are original posts the founder shipped (queue worker or
  // inline post path flips state='completed' + sets completedAt).
  const planRows = await db
    .select({
      id: planItems.id,
      output: planItems.output,
      title: planItems.title,
      channel: planItems.channel,
      completedAt: planItems.completedAt,
      createdAt: planItems.createdAt,
    })
    .from(planItems)
    .where(
      and(
        eq(planItems.userId, userId),
        eq(planItems.state, 'completed'),
        eq(planItems.kind, 'content_post'),
        isNotNull(planItems.completedAt),
        gte(planItems.completedAt, since),
      ),
    )
    .orderBy(desc(planItems.completedAt));

  // Best-effort externalUrl lookup from activity_events (post_published)
  // keyed by planItemId. The inline post path writes this; the queue
  // worker also writes this. Posts that pre-date the activity_events
  // instrumentation won't have a URL, in which case externalUrl stays
  // null and the History card body still renders.
  const planItemIds = planRows.map((r) => r.id);
  const eventRows =
    planItemIds.length === 0
      ? []
      : await db
          .select({
            planItemId: sql<string>`(${activityEvents.metadataJson} ->> 'planItemId')`,
            externalUrl: sql<string>`(${activityEvents.metadataJson} ->> 'externalUrl')`,
          })
          .from(activityEvents)
          .where(
            and(
              eq(activityEvents.userId, userId),
              eq(activityEvents.eventType, 'post_published'),
            ),
          );
  const externalUrlByPlanItem = new Map<string, string>();
  for (const ev of eventRows) {
    if (ev.planItemId && ev.externalUrl) {
      externalUrlByPlanItem.set(ev.planItemId, ev.externalUrl);
    }
  }

  const replyItems: BriefingHistoryItem[] = rows
    .filter((row) => {
      const hasBody =
        typeof row.replyBody === 'string' && row.replyBody.trim().length > 0;
      const hasThread =
        (typeof row.threadBody === 'string' &&
          row.threadBody.trim().length > 0) ||
        (typeof row.threadTitle === 'string' &&
          row.threadTitle.trim().length > 0);
      return hasBody && hasThread;
    })
    .map((row) => {
      const draftType: 'reply' | 'original_post' =
        row.draftType === 'original_post' ? 'original_post' : 'reply';
      return {
        id: row.draftId,
        draftId: row.draftId,
        todoType: 'reply_thread' as const,
        source: 'discovery' as const,
        priority: 'time_sensitive' as const,
        status: row.draftStatus === 'posted' ? 'posted' : 'handed_off',
        planState: null,
        xIntentUrl:
          row.threadPlatform === PLATFORMS.x.id &&
          row.replyBody &&
          row.threadExternalId
            ? buildXIntentUrl({
                text: row.replyBody,
                inReplyToTweetId: row.threadExternalId,
              })
            : null,
        title: row.threadTitle ?? 'Reply',
        platform: row.threadPlatform,
        community: row.threadCommunity,
        externalUrl: row.threadUrl,
        confidence: row.confidenceScore ?? null,
        scheduledFor: null,
        expiresAt: row.draftUpdatedAt.toISOString(),
        createdAt: row.draftCreatedAt.toISOString(),
        draftBody: row.replyBody,
        draftConfidence: row.confidenceScore ?? null,
        draftWhyItWorks: row.whyItWorks,
        draftType,
        draftPostTitle: row.postTitle,
        draftMedia: (row.media as TodoMedia[] | null) ?? null,
        threadTitle: row.threadTitle,
        threadBody: row.threadBody,
        threadAuthor: row.threadAuthor,
        threadUrl: row.threadUrl,
        threadUpvotes: row.threadUpvotes,
        threadCommentCount: row.threadCommentCount,
        threadPostedAt: row.threadPostedAt
          ? row.threadPostedAt.toISOString()
          : null,
        threadDiscoveredAt: row.threadDiscoveredAt.toISOString(),
        threadLikesCount: row.threadLikesCount,
        threadRepostsCount: row.threadRepostsCount,
        threadRepliesCount: row.threadRepliesCount,
        threadViewsCount: row.threadViewsCount,
        threadIsRepost: row.threadIsRepost,
        threadOriginalUrl: row.threadOriginalUrl,
        threadOriginalAuthorUsername: row.threadOriginalAuthorUsername,
        threadSurfacedVia: row.threadSurfacedVia,
        calendarContentType: null,
        calendarScheduledAt: null,
      };
    });

  // Project completed content_post plan_items into the same shape.
  // Settled cards (status='posted') are read-only — no xIntentUrl
  // handoff, no thread join. Reuse plan_item.id as the card id.
  const postItems: BriefingHistoryItem[] = planRows.map((row) => {
    const completedAt = row.completedAt ?? row.createdAt;
    const body = readDraftBody(row.output);
    const externalUrl = externalUrlByPlanItem.get(row.id) ?? null;
    return {
      id: row.id,
      draftId: row.id,
      todoType: 'reply_thread' as const,
      source: 'discovery' as const,
      priority: 'time_sensitive' as const,
      status: 'posted' as const,
      planState: null,
      xIntentUrl: null,
      title: row.title,
      platform: row.channel ?? 'x',
      community: null,
      externalUrl,
      confidence: null,
      scheduledFor: null,
      expiresAt: completedAt.toISOString(),
      createdAt: completedAt.toISOString(),
      draftBody: body,
      draftConfidence: null,
      draftWhyItWorks: null,
      draftType: 'original_post',
      draftPostTitle: null,
      draftMedia: null,
      threadTitle: null,
      threadBody: null,
      threadAuthor: null,
      threadUrl: null,
      threadUpvotes: null,
      threadCommentCount: null,
      threadPostedAt: null,
      threadDiscoveredAt: null,
      threadLikesCount: null,
      threadRepostsCount: null,
      threadRepliesCount: null,
      threadViewsCount: null,
      threadIsRepost: false,
      threadOriginalUrl: null,
      threadOriginalAuthorUsername: null,
      threadSurfacedVia: null,
      calendarContentType: null,
      calendarScheduledAt: null,
    };
  });

  // Merge both streams, newest first by expiresAt
  // (draft updatedAt for replies, completedAt for posts).
  const items: BriefingHistoryItem[] = [...replyItems, ...postItems].sort(
    (a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt),
  );

  return NextResponse.json({ items, windowDays: HISTORY_WINDOW_DAYS });
}
