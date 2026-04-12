import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { drafts, posts, threads, channels, activityEvents } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { RedditClient } from '@/lib/reddit-client';
import { runAgent, createToolContext } from '@/bridge/agent-runner';
import { loadAgentFromFile } from '@/bridge/load-agent';
import { redditPostTool } from '@/tools/reddit-post';
import { redditVerifyTool } from '@/tools/reddit-verify';
import type { ToolDefinition } from '@/bridge/types';
import { isCircuitBreakerTripped, tripCircuitBreaker } from '@/lib/circuit-breaker';
import { canPostToSubreddit } from '@/lib/rate-limiter';
import { publishEvent } from '@/lib/redis';
import { join } from 'path';
import { z } from 'zod';
import type { PostingJobData } from '@/lib/queue/types';

const postingOutputSchema = z.object({
  success: z.boolean(),
  commentId: z.string().nullable(),
  permalink: z.string().nullable(),
  verified: z.boolean(),
  shadowbanned: z.boolean(),
  error: z.string().optional(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toolRegistry = new Map<string, ToolDefinition<any, any>>([
  ['reddit_post', redditPostTool],
  ['reddit_verify', redditVerifyTool],
]);

export async function processPosting(job: Job<PostingJobData>) {
  const { userId, draftId, channelId } = job.data;

  // Check circuit breaker FIRST
  const breaker = await isCircuitBreakerTripped(userId);
  if (breaker.tripped) {
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
    throw new Error(
      `Rate limit: 0/${rateLimit.remaining} posts remaining in r/${thread.subreddit}`,
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

  // Load agent
  const agentConfig = loadAgentFromFile(
    join(process.cwd(), 'src/agents/posting.md'),
    toolRegistry,
  );

  const context = createToolContext({ redditClient });

  const userMessage = JSON.stringify({
    threadFullname: `t3_${thread.externalId}`,
    draftText: draft.replyBody,
  });

  const { result, usage } = await runAgent(
    agentConfig,
    userMessage,
    context,
    postingOutputSchema,
  );

  if (result.success && result.commentId) {
    // Insert post record
    await db.insert(posts).values({
      draftId,
      userId,
      externalId: result.commentId,
      externalUrl: result.permalink
        ? `https://reddit.com${result.permalink}`
        : null,
      subreddit: thread.subreddit,
      status: result.verified ? 'verified' : 'posted',
    });

    // Update draft status
    await db
      .update(drafts)
      .set({ status: 'posted', updatedAt: new Date() })
      .where(eq(drafts.id, draftId));

    // Shadowban detection: trip circuit breaker
    if (result.shadowbanned) {
      await tripCircuitBreaker(
        userId,
        `Shadowban detected on comment ${result.commentId} in r/${thread.subreddit}`,
      );
    }
  } else {
    // Post failed
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
      subreddit: thread.subreddit,
      commentId: result.commentId,
      shadowbanned: result.shadowbanned,
      error: result.error,
      cost: usage.costUsd,
    },
  });

  // Publish SSE event
  await publishEvent(`shipflare:events:${userId}`, {
    type: result.success ? 'post_published' : 'post_failed',
    subreddit: thread.subreddit,
    shadowbanned: result.shadowbanned,
  });
}
