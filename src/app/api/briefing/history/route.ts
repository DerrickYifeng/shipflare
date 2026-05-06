import { NextResponse } from 'next/server';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts, threads } from '@/lib/db/schema';
import { PLATFORMS } from '@/lib/platform-config';
import { buildXIntentUrl } from '@/lib/x-intent-url';

// Briefing → History tab. Surfaces reply drafts the founder has already
// acted on within the trailing window so they can re-open the X compose
// tab (handoff items) or jump back to a posted Reddit thread. The shape
// mirrors the Today feed's reply rows so <ReplyCard /> can render either
// without branching on the data source.
//
// v1 = replies only. Posted-original-post history (plan_items.state =
// 'completed') is a follow-up.

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
  /** Server-side `updated_at` of the underlying draft — when the user acted. */
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

  const items: BriefingHistoryItem[] = rows
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

  return NextResponse.json({ items, windowDays: HISTORY_WINDOW_DAYS });
}
