import { NextResponse, type NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts, channels, threads, planItems, activityEvents } from '@/lib/db/schema';
import { enqueuePosting } from '@/lib/queue';
import { paramsSchema, findOwnedPlanItem, type OwnedRow } from '@/app/api/plan-item/[id]/_helpers';
import { createClientFromChannelById } from '@/lib/platform-deps';
import { XClient } from '@/lib/x-client';
import { RedditClient } from '@/lib/reddit-client';
import { PLATFORMS } from '@/lib/platform-config';
import { createLogger, loggerForRequest } from '@/lib/logger';

const baseLog = createLogger('api:today:post-now');

/**
 * POST /api/today/:id/post-now
 *
 * Publishes a draft RIGHT NOW, bypassing the pacer's spacing/quiet-hours
 * delay. Three flows:
 *
 *   A. plan_item with linked draft   → enqueue with delayMs=0 (worker posts).
 *   B. plan_item, kind=content_post,
 *      no linked draft (legacy)     → post inline via xClient.postTweet,
 *                                     update plan_items state, log to
 *                                     activity_events. Skips the drafts/
 *                                     posts FK chain because content_post
 *                                     bodies live in plan_items.output.
 *   C. drafts.id direct (reply card) → enqueue with delayMs=0.
 *
 *   200 { success: true }
 *   400 invalid_id
 *   401 unauthorized
 *   404 not_found / channel_not_found
 *   409 not_postable (draft is in a terminal state)
 *   502 post_failed (platform API error)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { log, traceId } = loggerForRequest(baseLog, request);

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: rawId } = await params;
  const parsed = paramsSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_id' },
      { status: 400, headers: { 'x-trace-id': traceId } },
    );
  }

  const planRow = await findOwnedPlanItem(parsed.data.id, session.user.id);
  let draftId: string | null = null;
  if (planRow) {
    draftId = await findDraftIdForPlanItemAnyStatus(planRow.id);
    // Flow B: plan_item without a linked draft. Original posts (content_post)
    // currently live in plan_items.output.draft_body — not the drafts table —
    // so the dispatcher / queue path can't reach them. Post inline.
    if (!draftId && planRow.kind === 'content_post') {
      return postContentPostInline(planRow, session.user.id, traceId, log);
    }
  } else {
    draftId = parsed.data.id;
  }

  if (!draftId) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }

  // Load the draft with its channel for enqueue.
  const [draftRow] = await db
    .select({
      draftId: drafts.id,
      draftUserId: drafts.userId,
      draftStatus: drafts.status,
      threadPlatform: threads.platform,
    })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(and(eq(drafts.id, draftId), eq(drafts.userId, session.user.id)))
    .limit(1);

  if (!draftRow) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }

  // Accept both 'approved' (already went through dispatcher / queue) and
  // 'pending' (X handoff path — drafts.status stays pending until user
  // explicitly clicks Post now). Anything terminal is rejected.
  if (
    draftRow.draftStatus !== 'approved' &&
    draftRow.draftStatus !== 'pending'
  ) {
    return NextResponse.json(
      { error: 'not_postable', current: draftRow.draftStatus },
      { status: 409, headers: { 'x-trace-id': traceId } },
    );
  }

  // Promote pending → approved so the posting worker accepts the job.
  if (draftRow.draftStatus === 'pending') {
    await db
      .update(drafts)
      .set({ status: 'approved', updatedAt: new Date() })
      .where(eq(drafts.id, draftId));
  }

  const [channelRow] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.userId, session.user.id),
        eq(channels.platform, draftRow.threadPlatform),
      ),
    )
    .limit(1);

  if (!channelRow) {
    return NextResponse.json(
      { error: 'channel_not_found' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }

  await enqueuePosting(
    {
      userId: session.user.id,
      draftId,
      channelId: channelRow.id,
      mode: 'direct',
      traceId,
    },
    { delayMs: 0 },
  );

  log.info(`post-now enqueued for draft ${draftId} (bypassing pacer delay)`);
  return NextResponse.json(
    { success: true },
    { headers: { 'x-trace-id': traceId } },
  );
}

/**
 * Look up the draft linked to a plan_item without filtering on status.
 * (`findDraftIdForPlanItem` filters status='pending', which excludes the
 * 'approved' rows we want here.)
 */
async function findDraftIdForPlanItemAnyStatus(
  planItemId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(eq(drafts.planItemId, planItemId))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Synchronously post a content_post plan_item that has no linked drafts row.
 * Legacy gap: content-manager(post_batch) (and the now-retired post-writer
 * before it) only persists into `plan_items.output.draft_body`, never into
 * the `drafts` table that backs the dispatch-approve flow. Bypasses the
 * worker queue entirely.
 */
async function postContentPostInline(
  planRow: OwnedRow,
  userId: string,
  traceId: string,
  log: ReturnType<typeof createLogger>,
): Promise<Response> {
  // Pull the draft body + channel off the plan_item row.
  const [full] = await db
    .select({ output: planItems.output, channel: planItems.channel })
    .from(planItems)
    .where(eq(planItems.id, planRow.id))
    .limit(1);

  const draftText = readDraftBody(full?.output);
  const channelKey = full?.channel ?? null;
  if (!draftText || !channelKey) {
    return NextResponse.json(
      { error: 'no_draft_body' },
      { status: 409, headers: { 'x-trace-id': traceId } },
    );
  }

  // Resolve the user's channel + platform client.
  const [channelRow] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.userId, userId), eq(channels.platform, channelKey)))
    .limit(1);

  if (!channelRow) {
    return NextResponse.json(
      { error: 'channel_not_found' },
      { status: 404, headers: { 'x-trace-id': traceId } },
    );
  }

  const resolved = await createClientFromChannelById(channelRow.id);
  if (!resolved) {
    return NextResponse.json(
      { error: 'client_unavailable' },
      { status: 502, headers: { 'x-trace-id': traceId } },
    );
  }

  // Direct synchronous post. We avoid importing postViaDirectMode from the
  // worker module — that drags the full agent/tool registry into the Next
  // App Router build, which Turbopack chokes on (twitter-text ESM interop).
  // No drafts/posts row written — content_post pre-dates the drafts
  // .planItemId linkage and skipping is pragmatic until content-manager
  // is updated to insert drafts rows.
  const result = await postOriginalDirect(resolved.client, resolved.platform, draftText);

  if (!result.success) {
    log.error(`post-now inline post failed: ${result.error ?? 'unknown'}`);
    await db.insert(activityEvents).values({
      userId,
      eventType: 'post_failed',
      metadataJson: {
        planItemId: planRow.id,
        platform: resolved.platform,
        error: result.error,
        source: 'post_now_inline',
      },
    });
    return NextResponse.json(
      { error: 'post_failed', detail: result.error ?? 'unknown' },
      { status: 502, headers: { 'x-trace-id': traceId } },
    );
  }

  // Mark plan_item completed. Direct UPDATE matches the existing pattern in
  // posting.ts:307 (worker also writes plan_items.state directly).
  await db
    .update(planItems)
    .set({ state: 'completed', completedAt: new Date(), updatedAt: new Date() })
    .where(eq(planItems.id, planRow.id));

  await db.insert(activityEvents).values({
    userId,
    eventType: 'post_published',
    metadataJson: {
      planItemId: planRow.id,
      platform: resolved.platform,
      externalId: result.externalId,
      externalUrl: result.externalUrl,
      source: 'post_now_inline',
    },
  });

  log.info(
    `post-now inline posted ${result.externalId} for plan_item ${planRow.id}`,
  );
  return NextResponse.json(
    { success: true, externalUrl: result.externalUrl },
    { headers: { 'x-trace-id': traceId } },
  );
}

/** Same shape as today/route.ts — pull draft_body string off plan_items.output. */
function readDraftBody(output: unknown): string | null {
  if (output === null || typeof output !== 'object') return null;
  const value = (output as Record<string, unknown>).draft_body;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

interface DirectPostResult {
  success: boolean;
  externalId: string | null;
  externalUrl: string | null;
  error?: string;
}

/**
 * Inline copy of the worker's direct-post path for ORIGINAL POSTS only
 * (the Post-now inline branch never handles replies). Lives here instead
 * of being imported from `@/workers/processors/posting` so the App Router
 * build doesn't pull the agent registry / twitter-text validators.
 */
async function postOriginalDirect(
  client: XClient | RedditClient,
  platform: string,
  text: string,
): Promise<DirectPostResult> {
  try {
    if (platform === PLATFORMS.x.id) {
      if (!(client instanceof XClient)) {
        throw new Error('postOriginalDirect: X platform requires XClient');
      }
      const r = await client.postTweet(text);
      return { success: true, externalId: r.tweetId, externalUrl: r.url };
    }
    // Reddit original post path. Currently unreachable because Reddit is
    // gated off in MVP, but kept symmetric so flipping enabled=true Just
    // Works. Reddit submitPost needs subreddit + title — content_post
    // plan_items don't carry those today (they live in plan_items.output
    // for posts, but not at this granularity), so reject loudly.
    if (!(client instanceof RedditClient)) {
      throw new Error('postOriginalDirect: Reddit platform requires RedditClient');
    }
    return {
      success: false,
      externalId: null,
      externalUrl: null,
      error: 'reddit_inline_post_not_supported_yet',
    };
  } catch (err) {
    return {
      success: false,
      externalId: null,
      externalUrl: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
