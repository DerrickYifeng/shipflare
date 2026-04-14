import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import {
  products,
  channels,
  drafts,
  posts,
  threads,
  activityEvents,
} from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { XClient, XForbiddenError } from '@/lib/x-client';
import { runAgent, createToolContext } from '@/bridge/agent-runner';
import { loadAgentFromFile } from '@/bridge/load-agent';
import { registry } from '@/tools/registry';
import { engagementMonitorOutputSchema } from '@/agents/schemas';
import { enqueueReview } from '@/lib/queue';
import { publishEvent } from '@/lib/redis';
import { join } from 'path';
import type { XEngagementJobData } from '@/lib/queue/types';
import { createLogger } from '@/lib/logger';

const MAX_ENGAGEMENT_DEPTH = 2;

const log = createLogger('worker:x-engagement');

export async function processXEngagement(job: Job<XEngagementJobData>) {
  const { userId, tweetId, originalText, productId } = job.data;
  log.info(`Monitoring engagement for tweet ${tweetId}`);

  // Load X channel
  const [xChannel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.userId, userId), eq(channels.platform, 'x')))
    .limit(1);

  if (!xChannel) throw new Error('No X channel connected');

  const xClient = XClient.fromChannel(xChannel);

  // Get authenticated user ID
  let xUserId: string;
  try {
    const me = await xClient.getMe();
    xUserId = me.id;
  } catch {
    log.error('Failed to get authenticated user ID');
    return;
  }

  // Load product name for agent context
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  const productName = product?.name ?? 'ShipFlare';

  // Load and run engagement monitor agent
  const toolMap = registry.toMap();
  const cwd = process.cwd();
  const agentConfig = loadAgentFromFile(
    join(cwd, 'src/agents/engagement-monitor.md'),
    toolMap,
  );

  const context = createToolContext({ xClient });

  const userMessage = JSON.stringify({
    platform: 'x',
    tweetId,
    originalText,
    userId: xUserId,
    productName,
  });

  try {
    const { result, usage } = await runAgent(
      agentConfig,
      userMessage,
      context,
      engagementMonitorOutputSchema,
    );

    const actionableMentions = result.mentions.filter((m) => m.shouldReply);

    log.info(
      `Found ${result.mentions.length} mentions, ${actionableMentions.length} actionable, cost $${usage.costUsd.toFixed(4)}`,
    );

    // Look up the original posted draft to inherit engagement depth
    let parentDepth = 0;
    const [parentPost] = await db
      .select({ draftId: posts.draftId })
      .from(posts)
      .where(eq(posts.externalId, tweetId))
      .limit(1);

    if (parentPost) {
      const [parentDraft] = await db
        .select({ engagementDepth: drafts.engagementDepth })
        .from(drafts)
        .where(eq(drafts.id, parentPost.draftId))
        .limit(1);
      parentDepth = parentDraft?.engagementDepth ?? 0;
    }

    const childDepth = parentDepth + 1;

    if (childDepth > MAX_ENGAGEMENT_DEPTH) {
      log.info(
        `Skipping engagement draft creation for tweet ${tweetId}: depth ${childDepth} exceeds max ${MAX_ENGAGEMENT_DEPTH}`,
      );
      return;
    }

    // Create drafts for actionable mentions
    let draftsCreated = 0;
    for (const mention of actionableMentions) {
      if (!mention.draftReply) continue;

      // Create thread record for the mention
      const [threadRecord] = await db
        .insert(threads)
        .values({
          userId,
          externalId: mention.mentionId,
          platform: 'x',
          community: `@${mention.authorUsername}`,
          title: mention.text.slice(0, 200),
          url: `https://x.com/${mention.authorUsername}/status/${mention.mentionId}`,
          relevanceScore: mention.priority === 'high' ? 0.9 : mention.priority === 'medium' ? 0.7 : 0.5,
        })
        .onConflictDoNothing()
        .returning();

      if (!threadRecord) continue;

      const [draft] = await db
        .insert(drafts)
        .values({
          userId,
          threadId: threadRecord.id,
          draftType: 'reply',
          replyBody: mention.draftReply,
          confidenceScore:
            mention.priority === 'high'
              ? 0.9
              : mention.priority === 'medium'
                ? 0.7
                : 0.5,
          whyItWorks: `${mention.priority} priority engagement reply to @${mention.authorUsername}`,
          engagementDepth: childDepth,
        })
        .returning();

      draftsCreated++;

      // Auto-enqueue review
      await enqueueReview({
        userId,
        draftId: draft.id,
        productId,
      });
    }

    // Publish SSE event for high-priority engagement
    if (actionableMentions.some((m) => m.priority === 'high')) {
      await publishEvent(`shipflare:events:${userId}`, {
        type: 'engagement_alert',
        tweetId,
        highPriorityCount: actionableMentions.filter(
          (m) => m.priority === 'high',
        ).length,
        totalMentions: result.mentions.length,
        draftsCreated,
      });
    }

    // Log activity
    await db.insert(activityEvents).values({
      userId,
      eventType: 'x_engagement_check',
      metadataJson: {
        tweetId,
        mentionsFound: result.mentions.length,
        actionable: actionableMentions.length,
        draftsCreated,
        cost: usage.costUsd,
      },
    });
  } catch (err) {
    if (err instanceof XForbiddenError) {
      log.warn('X API 403 — Basic tier required for getMentions. Skipping engagement monitoring.');
      return;
    }
    throw err;
  }
}
