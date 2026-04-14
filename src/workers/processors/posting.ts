import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { drafts, posts, threads, channels, activityEvents } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { RedditClient } from '@/lib/reddit-client';
import { XClient } from '@/lib/x-client';
import { runAgent, createToolContext } from '@/bridge/agent-runner';
import { loadAgentFromFile } from '@/bridge/load-agent';
import { registry } from '@/tools/registry';
import { isCircuitBreakerTripped, tripCircuitBreaker } from '@/lib/circuit-breaker';
import { canPostToSubreddit } from '@/lib/rate-limiter';
import { enqueueXEngagement } from '@/lib/queue';
import { publishEvent } from '@/lib/redis';
import { join } from 'path';
import { z } from 'zod';
import type { PostingJobData } from '@/lib/queue/types';
import { createLogger } from '@/lib/logger';

const MAX_ENGAGEMENT_DEPTH = 2;
const log = createLogger('worker:posting');

const postingOutputSchema = z.object({
  success: z.boolean(),
  draftType: z.enum(['reply', 'original_post']).optional(),
  commentId: z.string().nullable(),
  postId: z.string().nullable().optional(),
  permalink: z.string().nullable(),
  url: z.string().nullable().optional(),
  verified: z.boolean(),
  shadowbanned: z.boolean(),
  error: z.string().optional(),
});

export async function processPosting(job: Job<PostingJobData>) {
  const { userId, draftId, channelId } = job.data;

  log.info(`Posting draft ${draftId} for user ${userId}`);

  // Load draft + thread first (need thread.platform for platform checks)
  const [draft] = await db
    .select()
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .limit(1);

  if (!draft) throw new Error(`Draft not found: ${draftId}`);
  if (draft.status !== 'approved') {
    throw new Error(`Draft not approved: ${draft.status}`);
  }

  const [thread] = await db
    .select()
    .from(threads)
    .where(eq(threads.id, draft.threadId))
    .limit(1);

  if (!thread) throw new Error(`Thread not found: ${draft.threadId}`);

  // Reddit-only safety checks (circuit breaker + subreddit rate limit)
  if (thread.platform !== 'x') {
    const breaker = await isCircuitBreakerTripped(userId);
    if (breaker.tripped) {
      log.warn(`Circuit breaker tripped for user ${userId}: ${breaker.reason}`);
      throw new Error(`Circuit breaker tripped: ${breaker.reason}`);
    }

    const rateLimit = await canPostToSubreddit(userId, thread.community);
    if (!rateLimit.allowed) {
      log.warn(`Rate limited in r/${thread.community} for user ${userId}`);
      throw new Error(
        `Rate limit: ${rateLimit.remaining} posts remaining in r/${thread.community}, resets at ${rateLimit.resetAt.toISOString()}`,
      );
    }
  }

  // Load channel
  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  if (!channel) throw new Error(`Channel not found: ${channelId}`);

  const isX = channel.platform === 'x';
  const draftType = draft.draftType ?? 'reply';

  // Load platform-specific agent and client
  const toolMap = registry.toMap();
  const cwd = process.cwd();

  const agentConfig = loadAgentFromFile(
    join(cwd, 'src/agents/posting.md'),
    toolMap,
  );

  const context = isX
    ? createToolContext({ xClient: XClient.fromChannel(channel) })
    : createToolContext({ redditClient: RedditClient.fromChannel(channel) });

  const userMessage = JSON.stringify({
    platform: isX ? 'x' : 'reddit',
    draftType,
    draftText: draft.replyBody,
    // Reddit-specific
    ...(isX ? {} : {
      threadFullname: `t3_${thread.externalId}`,
      subreddit: thread.community,
      postTitle: draft.postTitle ?? undefined,
    }),
    // X-specific
    ...(isX ? {
      tweetId: thread.externalId,
      topic: thread.community,
    } : {}),
  });

  const { result, usage } = await runAgent(
    agentConfig,
    userMessage,
    context,
    postingOutputSchema,
  );

  const externalId = result.commentId ?? result.postId ?? null;
  const externalUrl = isX
    ? result.url ?? null
    : result.permalink
      ? `https://reddit.com${result.permalink}`
      : result.url ?? null;

  if (result.success && externalId) {
    log.info(`Posted ${draftType} ${externalId} to r/${thread.community}`);

    // Insert post record
    await db.insert(posts).values({
      draftId,
      userId,
      externalId,
      externalUrl,
      community: thread.community,
      status: result.verified ? 'verified' : 'posted',
    });

    // Update draft status
    await db
      .update(drafts)
      .set({ status: 'posted', updatedAt: new Date() })
      .where(eq(drafts.id, draftId));

    // Shadowban detection: trip circuit breaker (Reddit replies only)
    if (!isX && result.shadowbanned && draftType === 'reply') {
      log.error(`SHADOWBAN detected: ${externalId} in r/${thread.community}`);
      await tripCircuitBreaker(
        userId,
        `Shadowban detected on ${externalId} in r/${thread.community}`,
      );
    }

    // X-specific post-publish actions
    if (isX && externalId) {
      // Skip engagement monitoring for deep engagement replies
      if (draft.engagementDepth >= MAX_ENGAGEMENT_DEPTH) {
        log.info(
          `Skipping engagement monitoring for tweet ${externalId}: depth ${draft.engagementDepth} >= max ${MAX_ENGAGEMENT_DEPTH}`,
        );
      } else {
        // Schedule engagement monitoring at +15, +30, +60 minutes
        for (const delayMin of [15, 30, 60]) {
          await enqueueXEngagement(
            {
              userId,
              tweetId: externalId,
              originalText: draft.replyBody,
              productId: '',
            },
            delayMin * 60 * 1000,
          );
        }
        log.info(`Scheduled engagement monitoring for tweet ${externalId}`);
      }
    }
  } else {
    // Post failed
    log.error(`Post failed for draft ${draftId}: ${result.error ?? 'unknown'}`);
    await db
      .update(drafts)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(drafts.id, draftId));
  }

  // Log activity
  await db.insert(activityEvents).values({
    userId,
    eventType: result.success ? 'post_published' : 'post_failed',
    metadataJson: {
      draftId,
      draftType,
      community: thread.community,
      commentId: result.commentId,
      postId: result.postId,
      shadowbanned: result.shadowbanned,
      error: result.error,
      cost: usage.costUsd,
    },
  });

  // Publish SSE event
  await publishEvent(`shipflare:events:${userId}`, {
    type: result.success ? 'post_published' : 'post_failed',
    draftType,
    community: thread.community,
    shadowbanned: result.shadowbanned,
  });
}
