import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts, threads, channels, xMonitoredTweets } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { enqueuePosting } from '@/lib/queue';
import { createLogger, loggerForRequest } from '@/lib/logger';
import { PLATFORMS } from '@/lib/platform-config';
import { recordPipelineEvent, recordThreadFeedback } from '@/lib/pipeline-events';

const baseLog = createLogger('api:drafts');

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Return drafts that need user attention: pending (reviewed + passed) and needs_revision
  // Enrich with source context: monitor tweets, calendar items, platform
  const results = await db
    .select({
      id: drafts.id,
      threadId: drafts.threadId,
      draftType: drafts.draftType,
      postTitle: drafts.postTitle,
      replyBody: drafts.replyBody,
      confidenceScore: drafts.confidenceScore,
      whyItWorks: drafts.whyItWorks,
      ftcDisclosure: drafts.ftcDisclosure,
      status: drafts.status,
      reviewVerdict: drafts.reviewVerdict,
      reviewScore: drafts.reviewScore,
      reviewJson: drafts.reviewJson,
      engagementDepth: drafts.engagementDepth,
      createdAt: drafts.createdAt,
      threadTitle: threads.title,
      threadCommunity: threads.community,
      threadUrl: threads.url,
      threadPlatform: threads.platform,
      // Monitor context
      monitorReplyDeadline: xMonitoredTweets.replyDeadline,
      monitorStatus: xMonitoredTweets.status,
    })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .leftJoin(
      xMonitoredTweets,
      and(
        eq(threads.externalId, xMonitoredTweets.tweetId),
        eq(xMonitoredTweets.userId, session.user.id),
      ),
    )
    .where(
      and(
        eq(drafts.userId, session.user.id),
        inArray(drafts.status, ['pending', 'needs_revision']),
      ),
    )
    .orderBy(drafts.createdAt);

  const now = new Date();

  return NextResponse.json({
    drafts: results.map((r) => {
      // Determine source
      let source: 'monitor' | 'calendar' | 'engagement' | 'discovery' = 'discovery';
      if (r.monitorReplyDeadline) {
        source = 'monitor';
      } else if (r.engagementDepth > 0) {
        source = 'engagement';
      } else if (
        r.threadCommunity?.startsWith('@') &&
        r.threadPlatform === 'x'
      ) {
        source = 'engagement';
      }

      // Determine urgency
      let urgency: 'critical' | 'high' | 'normal' = 'normal';
      if (r.monitorReplyDeadline) {
        const msLeft = r.monitorReplyDeadline.getTime() - now.getTime();
        if (msLeft < 5 * 60 * 1000) urgency = 'critical';
        else if (msLeft < 15 * 60 * 1000) urgency = 'high';
      }

      return {
        id: r.id,
        threadId: r.threadId,
        draftType: r.draftType,
        postTitle: r.postTitle,
        replyBody: r.replyBody,
        confidenceScore: r.confidenceScore,
        whyItWorks: r.whyItWorks,
        ftcDisclosure: r.ftcDisclosure,
        status: r.status,
        source,
        urgency,
        platform: r.threadPlatform ?? 'reddit',
        replyDeadline: r.monitorReplyDeadline?.toISOString() ?? null,
        review: r.reviewVerdict
          ? {
              verdict: r.reviewVerdict,
              score: r.reviewScore,
              ...(r.reviewJson as Record<string, unknown> ?? {}),
            }
          : null,
        createdAt: r.createdAt,
        thread: {
          title: r.threadTitle,
          community: r.threadCommunity,
          url: r.threadUrl,
        },
      };
    })
    // Sort: critical first, then high, then normal, then by date
    .sort((a, b) => {
      const urgencyOrder = { critical: 0, high: 1, normal: 2 };
      const diff = urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
      if (diff !== 0) return diff;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    }),
  });
}

export async function POST(request: NextRequest) {
  const { log, traceId } = loggerForRequest(baseLog, request);
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { draftId?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { draftId, action } = body;
  log.info(`POST /api/drafts action=${action} draftId=${draftId}`);

  if (!draftId || !action || !['approve', 'skip', 'retry'].includes(action)) {
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

    // Find the thread to determine platform, then find the right channel
    const [thread] = await db
      .select()
      .from(threads)
      .where(eq(threads.id, draft.threadId))
      .limit(1);

    const platform = thread?.platform ?? 'reddit';

    // Whitelist — only need id to enqueue the posting job.
    const [channel] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.userId, session.user.id), eq(channels.platform, platform)))
      .limit(1);

    if (channel) {
      log.info(`Draft ${draftId} approved (${platform}), posting enqueued`);
      await enqueuePosting({
        userId: session.user.id,
        draftId,
        channelId: channel.id,
        traceId,
      }, { delayMs: 0 });

      // Telemetry: stage='approved' + thread_feedback ground-truth label.
      await recordPipelineEvent({
        userId: session.user.id,
        threadId: draft.threadId,
        draftId,
        stage: 'approved',
        metadata: { platform, autoApproved: false },
      });
      await recordThreadFeedback({
        userId: session.user.id,
        threadId: draft.threadId,
        userAction: 'approve',
      });
    } else {
      const platformLabel = PLATFORMS[platform]?.displayName ?? platform;
      return NextResponse.json(
        { error: `No ${platformLabel} account connected. Connect your account first.` },
        { status: 400 },
      );
    }
  } else if (action === 'skip') {
    await db
      .update(drafts)
      .set({ status: 'skipped', updatedAt: new Date() })
      .where(eq(drafts.id, draftId));

    // Ground-truth label for the discovery optimization loop.
    await recordThreadFeedback({
      userId: session.user.id,
      threadId: draft.threadId,
      userAction: 'skip',
    });
  } else if (action === 'retry') {
    // Draft retry goes through the plan-execute dispatcher in Phase 7 once
    // plan_items carry the skill route. For now, surface a clear 410 instead
    // of silently doing nothing.
    return NextResponse.json(
      { error: 'Draft retry is temporarily disabled — lands with plan-execute in Phase 7' },
      { status: 410, headers: { 'x-trace-id': traceId } },
    );
  }

  return NextResponse.json(
    { success: true, traceId },
    { headers: { 'x-trace-id': traceId } },
  );
}
