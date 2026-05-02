import { NextResponse } from 'next/server';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts, planItems, threads } from '@/lib/db/schema';
import type { PlanItemState } from '@/lib/plan-state';
import { PLATFORMS } from '@/lib/platform-config';
import { buildXIntentUrl } from '@/lib/x-intent-url';

// V3 Today feed — merges two sources:
//
//  1. `plan_items` in `drafted | ready_for_review | approved`. These are
//     scheduled original posts drafted by the post-writer agent (channel
//     comes in via plan_items.channel). The draft body lives in
//     `plan_items.output.draft_body` (written by DraftPostTool).
//
//  2. `drafts` in `status='pending'` joined to `threads`. These are
//     reply drafts the content-manager agent drafted against scanned
//     threads (discovery / reply-guy flow).
//
// Both shapes get projected into the same `TodoItem`-looking row so the
// existing <TodayContent /> UI keeps working. `cardFormat` is derived on
// the client from `draftType` (`reply` vs `original_post`), which is why
// we surface that field explicitly.
//
// The previous implementation only queried plan_items AND hard-coded
// `draftBody: null`, which is why users saw empty post cards and
// scanned-thread replies never appeared at all.

// Today surfaces items that have a draft body the user can read + approve.
// Bare `planned` items (tactical-planner just scheduled, draft skill hasn't
// run yet) belong in TacticalProgressCard's "drafting X of Y" view, not
// here — otherwise users see topic-only cards with an "Approve topic"
// button and no body to judge.
const PENDING_PLAN_STATES = [
  'drafted',
  'ready_for_review',
  'approved',
] as const satisfies readonly PlanItemState[];

function dayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

/**
 * Priority bucket the UI uses to color the card + sort the rail. We derive
 * it from `scheduledAt` relative to now:
 *   - already past → time_sensitive (overdue, user should act)
 *   - within today → time_sensitive
 *   - tomorrow+   → scheduled
 * The `optional` bucket isn't emitted yet — it's reserved for plan items
 * with userAction='auto' that the user can dismiss but isn't expected to
 * approve; we'll plumb that through when the auto-execute path ships.
 */
function derivePriority(
  scheduledAt: Date,
  now: Date,
): 'time_sensitive' | 'scheduled' | 'optional' {
  const { end } = dayBounds(now);
  if (scheduledAt.getTime() < end.getTime()) return 'time_sensitive';
  return 'scheduled';
}

interface TodoMedia {
  url: string;
  type: 'image' | 'gif' | 'video';
  alt?: string;
}

interface TodoItemRow {
  id: string;
  draftId: string | null;
  todoType: 'approve_post' | 'reply_thread' | 'respond_engagement';
  source: 'calendar' | 'discovery' | 'engagement';
  priority: 'time_sensitive' | 'scheduled' | 'optional';
  status: 'pending';
  /**
   * For calendar / plan_item rows: the underlying plan_items.state. Lets the
   * UI distinguish "approved & queued for posting" from "drafted / awaiting
   * the user's first click". Null for reply-card rows (drafts table only).
   */
  planState: PlanItemState | null;
  /**
   * Pre-built X compose intent URL. Set for X drafts only (replies and
   * original posts). When non-null the UI bypasses the API/queue path
   * entirely — the user clicks once to open X compose pre-filled, posts
   * manually, and the card stays in the feed until they Skip it.
   */
  xIntentUrl: string | null;
  title: string;
  platform: string;
  community: string | null;
  externalUrl: string | null;
  confidence: number | null;
  scheduledFor: string | null;
  expiresAt: string;
  createdAt: string;
  draftBody: string | null;
  draftConfidence: number | null;
  draftWhyItWorks: string | null;
  draftType: 'reply' | 'original_post' | null;
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
  calendarContentType: string | null;
  calendarScheduledAt: string | null;
  /** Sort key (ms) — used only to merge the two sources into a stable
   *  order; not shipped to the client. */
  _sortKey: number;
}

/** Extract `draft_body` from `plan_items.output` without trusting its shape. */
function readDraftBody(output: unknown): string | null {
  if (output === null || typeof output !== 'object') return null;
  const value = (output as Record<string, unknown>).draft_body;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Extract `targetCount` from `plan_items.params` without trusting its shape. */
function readTargetCount(params: unknown): number | null {
  if (params === null || typeof params !== 'object') return null;
  const value = (params as Record<string, unknown>).targetCount;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

/**
 * Today-page reply slot: a `content_reply` plan_item scheduled for
 * today (UTC) with a positive `targetCount`. Surfaced separately from
 * the post + draft cards so the UI can render a "Today's reply session:
 * Y of N drafted" progress card instead of an empty placeholder.
 */
export interface ReplySlotRow {
  id: string;
  channel: string;
  scheduledAt: string;
  targetCount: number;
  draftedToday: number;
  state: 'planned' | 'drafted' | 'completed';
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const now = new Date();
  const { start: todayStart, end: todayEnd } = dayBounds(now);
  const yStart = new Date(todayStart);
  yStart.setUTCDate(yStart.getUTCDate() - 1);

  // ------------------------------------------------------------------
  // 1) Pending scheduled posts (plan_items with a drafted body)
  // ------------------------------------------------------------------
  const pendingPlan = await db
    .select({
      id: planItems.id,
      kind: planItems.kind,
      state: planItems.state,
      channel: planItems.channel,
      scheduledAt: planItems.scheduledAt,
      title: planItems.title,
      description: planItems.description,
      createdAt: planItems.createdAt,
      output: planItems.output,
    })
    .from(planItems)
    .where(
      and(
        eq(planItems.userId, userId),
        inArray(planItems.state, PENDING_PLAN_STATES),
      ),
    )
    .orderBy(planItems.scheduledAt);

  // ------------------------------------------------------------------
  // 2) Pending reply drafts (content-manager output) + joined thread
  // ------------------------------------------------------------------
  const pendingDraftRows = await db
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
      and(eq(drafts.userId, userId), eq(drafts.status, 'pending')),
    )
    .orderBy(desc(drafts.createdAt));

  // Dedupe by threadId. `DraftReplyTool` is now idempotent on
  // (userId, threadId, status='pending'), and a partial unique index
  // backs that at the DB level — but legacy rows that pre-date the
  // fix can still live in `drafts`, and the dedupe here keeps the
  // feed clean until those age out. Rows are sorted newest-first by
  // `desc(drafts.createdAt)`, so the first occurrence wins.
  const seenThreadIds = new Set<string>();
  const pendingDrafts = pendingDraftRows.filter((row) => {
    if (seenThreadIds.has(row.threadId)) return false;
    seenThreadIds.add(row.threadId);
    return true;
  });

  // ------------------------------------------------------------------
  // 3) Today's reply slots (`content_reply` plan_items with a positive
  //    targetCount, scheduled for today's UTC window). Surface these
  //    so the UI can show "Today's reply session: Y of N drafted"
  //    progress separately from the per-thread reply cards.
  // ------------------------------------------------------------------
  const todayReplySlotRows = await db
    .select({
      id: planItems.id,
      channel: planItems.channel,
      state: planItems.state,
      scheduledAt: planItems.scheduledAt,
      params: planItems.params,
    })
    .from(planItems)
    .where(
      and(
        eq(planItems.userId, userId),
        eq(planItems.kind, 'content_reply'),
        gte(planItems.scheduledAt, todayStart),
        lt(planItems.scheduledAt, todayEnd),
        inArray(planItems.state, ['planned', 'drafted', 'completed']),
      ),
    )
    .orderBy(planItems.scheduledAt);

  // Count drafts created today on the relevant channel(s) so each
  // slot can render its "drafted Y of N" progress without the client
  // re-counting on every render. We count by (userId, draftType,
  // platform-of-thread, createdAt::date) — drafts join to threads to
  // resolve platform.
  const todayDraftRows = todayReplySlotRows.length === 0
    ? []
    : await db
        .select({
          platform: threads.platform,
          createdAt: drafts.createdAt,
        })
        .from(drafts)
        .innerJoin(threads, eq(drafts.threadId, threads.id))
        .where(
          and(
            eq(drafts.userId, userId),
            eq(drafts.draftType, 'reply'),
            gte(drafts.createdAt, todayStart),
            lt(drafts.createdAt, todayEnd),
          ),
        );
  const draftCountsByChannel = todayDraftRows.reduce<Record<string, number>>(
    (acc, row) => {
      const key = row.platform ?? '';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {},
  );

  // Stats — single aggregate round-trip. Yesterday completions, today
  // completions+skips, and the pending plan_items count.
  //
  // NOTE: The pg driver rejects raw Date objects in sql-template binds
  // ("Received an instance of Date"). Convert to ISO strings explicitly
  // — Postgres parses ISO-8601 into timestamptz without ambiguity.
  const yStartIso = yStart.toISOString();
  const todayStartIso = todayStart.toISOString();
  const todayEndIso = todayEnd.toISOString();
  const [planStats] = await db
    .select({
      publishedYesterday: sql<number>`
        count(*) filter (
          where ${planItems.state} = 'completed'
            and ${planItems.completedAt} >= ${yStartIso}
            and ${planItems.completedAt} < ${todayStartIso}
        )
      `.mapWith(Number),
      actedToday: sql<number>`
        count(*) filter (
          where ${planItems.state} in ('completed', 'skipped')
            and ${planItems.completedAt} >= ${todayStartIso}
            and ${planItems.completedAt} < ${todayEndIso}
        )
      `.mapWith(Number),
      planPending: sql<number>`
        count(*) filter (
          where ${planItems.state} in ('drafted', 'ready_for_review', 'approved')
        )
      `.mapWith(Number),
      anyItems: sql<number>`count(*)`.mapWith(Number),
    })
    .from(planItems)
    .where(eq(planItems.userId, userId));

  // Map plan_items → TodoItem rows. `content_reply` plan_items are
  // ALWAYS dropped from the items[] feed — they're slots, not cards.
  // Today's slots surface separately via the `replySlots` field so the
  // UI can render a single "Today's reply session: Y of N drafted"
  // progress card instead of empty placeholder cards. The actual reply
  // bodies (content-manager output) flow through the `pendingDrafts`
  // path below with full thread context.
  const planRows: TodoItemRow[] = pendingPlan
    .map((row) => {
      const draftBody = readDraftBody(row.output);
      return { row, draftBody };
    })
    .filter(({ row }) => {
      if (row.kind === 'content_reply') return false;
      return true;
    })
    .map(({ row, draftBody }) => ({
      id: row.id,
      draftId: null,
      todoType: 'approve_post' as const,
      source: 'calendar' as const,
      priority: derivePriority(row.scheduledAt, now),
      status: 'pending' as const,
      planState: row.state as PlanItemState,
      // Original posts always use the API queue path (Schedule → enqueue at
      // scheduledAt → "Post now" button when queued). The X programmatic-
      // post restriction from Feb 2026 only blocks REPLIES on non-Enterprise
      // tiers — original tweets can still be posted via POST /2/tweets.
      xIntentUrl: null,
      title: row.title,
      platform: row.channel ?? 'x',
      community: null,
      externalUrl: null,
      confidence: null,
      scheduledFor: row.scheduledAt.toISOString(),
      // Keep the expiresAt contract that the UI reads as a deadline: we
      // reuse scheduledAt here until plan_items grows a real SLA column.
      expiresAt: row.scheduledAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      draftBody,
      draftConfidence: null,
      draftWhyItWorks: null,
      draftType: draftBody ? ('original_post' as const) : null,
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
      calendarContentType: row.kind,
      calendarScheduledAt: row.scheduledAt.toISOString(),
      _sortKey: row.scheduledAt.getTime(),
    }));

  // Map drafts+threads → TodoItem rows. Drop rows where the draft has
  // no body OR the joined thread has no body — both produce an
  // unactionable empty card in the UI. The schema requires both
  // fields, but legacy / cancelled / bug-induced rows can slip
  // through; surface them in logs rather than the inbox.
  const replyRows: TodoItemRow[] = pendingDrafts
    .filter((row) => {
      const hasBody = typeof row.replyBody === 'string' && row.replyBody.trim().length > 0;
      const hasThread =
        (typeof row.threadBody === 'string' && row.threadBody.trim().length > 0) ||
        (typeof row.threadTitle === 'string' && row.threadTitle.trim().length > 0);
      return hasBody && hasThread;
    })
    .map((row) => {
    const draftType: 'reply' | 'original_post' =
      row.draftType === 'original_post' ? 'original_post' : 'reply';
    const isReply = draftType === 'reply';
    return {
      id: row.draftId,
      draftId: row.draftId,
      todoType: isReply ? 'reply_thread' : 'approve_post',
      source: 'discovery',
      // Replies are time-sensitive by default — the whole point of the
      // reply-guy loop is to respond while the thread is fresh.
      priority: 'time_sensitive',
      status: 'pending',
      planState: null,
      // X reply → browser handoff with in_reply_to pointing at the thread.
      // Reddit drafts keep xIntentUrl null and flow through the API.
      xIntentUrl:
        row.threadPlatform === PLATFORMS.x.id &&
        row.replyBody &&
        row.threadExternalId
          ? buildXIntentUrl({
              text: row.replyBody,
              inReplyToTweetId: row.threadExternalId,
            })
          : null,
      title: row.threadTitle ?? 'Reply opportunity',
      platform: row.threadPlatform,
      community: row.threadCommunity,
      externalUrl: row.threadUrl,
      confidence: row.confidenceScore ?? null,
      scheduledFor: null,
      expiresAt: row.draftCreatedAt.toISOString(),
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
      _sortKey: row.draftCreatedAt.getTime(),
    };
  });

  // Replies first (time-sensitive, newest on top), then scheduled posts
  // in schedule order. The UI splits them by `cardFormat` anyway, but
  // this keeps j/k keyboard nav landing on replies before posts.
  const merged = [...replyRows, ...planRows];
  const items = merged.map(({ _sortKey: _sk, ...rest }) => rest);

  // Build today's reply-slot progress rows for the UI. `state` only
  // takes 'planned' | 'drafted' | 'completed' here — the query already
  // filtered to those — but we narrow defensively in case the schema
  // adds new states later.
  const replySlots: ReplySlotRow[] = todayReplySlotRows
    .map((row) => {
      const target = readTargetCount(row.params);
      if (!row.channel || target == null || target <= 0) return null;
      const slotState: ReplySlotRow['state'] =
        row.state === 'planned' || row.state === 'drafted' || row.state === 'completed'
          ? row.state
          : 'planned';
      return {
        id: row.id,
        channel: row.channel,
        scheduledAt: row.scheduledAt.toISOString(),
        targetCount: target,
        draftedToday: draftCountsByChannel[row.channel] ?? 0,
        state: slotState,
      };
    })
    .filter((s): s is ReplySlotRow => s !== null);

  const planPending = planStats?.planPending ?? 0;
  const anyPlanItems = (planStats?.anyItems ?? 0) > 0;

  return NextResponse.json({
    items,
    replySlots,
    // First-run gate: "any plan items" OR "any reply drafts in flight"
    // counts as having started the loop. Otherwise users who connect X,
    // scan once, and get a reply draft before the first tactical plan
    // fires would still see the empty First Run state.
    hasAnyPlanItems: anyPlanItems || pendingDrafts.length > 0,
    stats: {
      published_yesterday: planStats?.publishedYesterday ?? 0,
      pending_count: planPending + pendingDrafts.length,
      acted_today: planStats?.actedToday ?? 0,
    },
  });
}
