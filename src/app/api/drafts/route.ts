import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { drafts, threads, channels, products } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { enqueuePosting, enqueueContent } from '@/lib/queue';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:drafts');

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Return drafts that need user attention: pending (reviewed + passed) and needs_revision
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
      createdAt: drafts.createdAt,
      threadTitle: threads.title,
      threadCommunity: threads.community,
      threadUrl: threads.url,
    })
    .from(drafts)
    .innerJoin(threads, eq(drafts.threadId, threads.id))
    .where(
      and(
        eq(drafts.userId, session.user.id),
        inArray(drafts.status, ['pending', 'needs_revision']),
      ),
    )
    .orderBy(drafts.createdAt);

  return NextResponse.json({
    drafts: results.map((r) => ({
      id: r.id,
      threadId: r.threadId,
      draftType: r.draftType,
      postTitle: r.postTitle,
      replyBody: r.replyBody,
      confidenceScore: r.confidenceScore,
      whyItWorks: r.whyItWorks,
      ftcDisclosure: r.ftcDisclosure,
      status: r.status,
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
    })),
  });
}

export async function POST(request: Request) {
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

    const [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.userId, session.user.id), eq(channels.platform, platform)))
      .limit(1);

    if (channel) {
      log.info(`Draft ${draftId} approved (${platform}), posting enqueued`);
      await enqueuePosting({
        userId: session.user.id,
        draftId,
        channelId: channel.id,
      });
    } else {
      return NextResponse.json(
        { error: `No ${platform === 'x' ? 'X' : 'Reddit'} account connected. Connect your account first.` },
        { status: 400 },
      );
    }
  } else if (action === 'skip') {
    await db
      .update(drafts)
      .set({ status: 'skipped', updatedAt: new Date() })
      .where(eq(drafts.id, draftId));
  } else if (action === 'retry') {
    // Re-enqueue content generation for flagged/needs_revision drafts
    if (!['flagged', 'needs_revision'].includes(draft.status)) {
      return NextResponse.json(
        { error: 'Can only retry flagged or needs_revision drafts' },
        { status: 400 },
      );
    }

    // Get user's product for re-generation
    const [product] = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.userId, session.user.id))
      .limit(1);

    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    await db
      .update(drafts)
      .set({ status: 'skipped', updatedAt: new Date() })
      .where(eq(drafts.id, draftId));

    await enqueueContent({
      userId: session.user.id,
      threadId: draft.threadId,
      productId: product.id,
      draftType: (draft.draftType as 'reply' | 'original_post') ?? 'reply',
    });

    log.info(`Draft ${draftId} retried, new content generation enqueued`);
  }

  return NextResponse.json({ success: true });
}
