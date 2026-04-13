import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { drafts, posts, threads, channels, activityEvents } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { RedditClient } from '@/lib/reddit-client';
import { runAgent, createToolContext } from '@/bridge/agent-runner';
import { loadAgentFromFile } from '@/bridge/load-agent';
import { registry } from '@/tools/registry';
import { isCircuitBreakerTripped, tripCircuitBreaker } from '@/lib/circuit-breaker';
import { canPostToSubreddit } from '@/lib/rate-limiter';
import { publishEvent } from '@/lib/redis';
import { join } from 'path';
import { z } from 'zod';
import type { PostingJobData } from '@/lib/queue/types';
import { createLogger } from '@/lib/logger';

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

  // Check circuit breaker FIRST
  const breaker = await isCircuitBreakerTripped(userId);
  if (breaker.tripped) {
    log.warn(`Circuit breaker tripped for user ${userId}: ${breaker.reason}`);
    throw new Error(`Circuit breaker tripped: ${breaker.reason}`);
  }

  // Load draft + thread
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

  // Check rate limit
  const rateLimit = await canPostToSubreddit(userId, thread.subreddit);
  if (!rateLimit.allowed) {
    log.warn(`Rate limited in r/${thread.subreddit} for user ${userId}`);
    throw new Error(
      `Rate limit: ${rateLimit.remaining} posts remaining in r/${thread.subreddit}, resets at ${rateLimit.resetAt.toISOString()}`,
    );
  }

  // Load channel
  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  if (!channel) throw new Error(`Channel not found: ${channelId}`);

  const redditClient = RedditClient.fromChannel(channel);
  const draftType = draft.draftType ?? 'reply';

  // Load agent with tools from registry
  const toolMap = registry.toMap();
  const agentConfig = loadAgentFromFile(
    join(process.cwd(), 'src/agents/posting.md'),
    toolMap,
  );

  const context = createToolContext({ redditClient });

  const userMessage = JSON.stringify({
    draftType,
    threadFullname: `t3_${thread.externalId}`,
    subreddit: thread.subreddit,
    postTitle: draft.postTitle ?? undefined,
    draftText: draft.replyBody,
  });

  const { result, usage } = await runAgent(
    agentConfig,
    userMessage,
    context,
    postingOutputSchema,
  );

  const externalId = result.commentId ?? result.postId ?? null;
  const externalUrl = result.permalink
    ? `https://reddit.com${result.permalink}`
    : result.url ?? null;

  if (result.success && externalId) {
    log.info(`Posted ${draftType} ${externalId} to r/${thread.subreddit}`);

    // Insert post record
    await db.insert(posts).values({
      draftId,
      userId,
      externalId,
      externalUrl,
      subreddit: thread.subreddit,
      status: result.verified ? 'verified' : 'posted',
    });

    // Update draft status
    await db
      .update(drafts)
      .set({ status: 'posted', updatedAt: new Date() })
      .where(eq(drafts.id, draftId));

    // Shadowban detection: trip circuit breaker (replies only)
    if (result.shadowbanned && draftType === 'reply') {
      log.error(`SHADOWBAN detected: ${externalId} in r/${thread.subreddit}`);
      await tripCircuitBreaker(
        userId,
        `Shadowban detected on ${externalId} in r/${thread.subreddit}`,
      );
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
      subreddit: thread.subreddit,
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
    subreddit: thread.subreddit,
    shadowbanned: result.shadowbanned,
  });
}
