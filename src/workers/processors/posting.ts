import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { drafts, posts, threads, channels, activityEvents } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { RedditClient } from '@/lib/reddit-client';
import { XClient } from '@/lib/x-client';
import { createClientFromChannel } from '@/lib/platform-deps';
import { PLATFORMS } from '@/lib/platform-config';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { isCircuitBreakerTripped, tripCircuitBreaker } from '@/lib/circuit-breaker';
import { canPostToSubreddit } from '@/lib/rate-limiter';
import { enqueueEngagement } from '@/lib/queue';
import { publishUserEvent } from '@/lib/redis';
import { join } from 'path';
import type { PostingJobData } from '@/lib/queue/types';
import { getTraceId } from '@/lib/queue/types';
import { postingOutputSchema } from '@/agents/schemas';
import type { PostingOutput } from '@/agents/schemas';
import { createLogger, loggerForJob } from '@/lib/logger';
import { getCostForRun } from '@/lib/cost-bucket';
import { recordPipelineEvent, recordThreadFeedback } from '@/lib/pipeline-events';

const MAX_ENGAGEMENT_DEPTH = 2;
const baseLog = createLogger('worker:posting');

const postingSkill = loadSkill(join(process.cwd(), 'src/skills/posting'));

export async function processPosting(job: Job<PostingJobData>) {
  const traceId = getTraceId(job.data, job.id);
  const log = loggerForJob(baseLog, job);
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

  // Reddit-only safety checks (circuit breaker + subreddit rate limit).
  // The shadowban circuit breaker and subreddit quota are Reddit-shaped
  // concepts; X has no equivalent per-topic cap.
  if (thread.platform === PLATFORMS.reddit.id) {
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

  // Load channel — explicit projection for fromChannel + platform routing
  const [channel] = await db
    .select({
      id: channels.id,
      platform: channels.platform,
      oauthTokenEncrypted: channels.oauthTokenEncrypted,
      refreshTokenEncrypted: channels.refreshTokenEncrypted,
      tokenExpiresAt: channels.tokenExpiresAt,
    })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  if (!channel) throw new Error(`Channel not found: ${channelId}`);

  const isX = channel.platform === PLATFORMS.x.id;
  const draftType = draft.draftType ?? 'reply';

  // Build input for the posting skill
  const input: Record<string, unknown> = {
    platform: channel.platform,
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
  };

  // Inject platform client as dependency. createClientFromChannel() is the
  // sanctioned path for processors that look up a channel by id.
  const client = createClientFromChannel(channel.platform, channel);
  if (!client) {
    throw new Error(`Unsupported platform for posting: ${channel.platform}`);
  }
  const deps: Record<string, unknown> = client instanceof XClient
    ? { xClient: client }
    : client instanceof RedditClient
      ? { redditClient: client }
      : {};

  const { results, usage } = await runSkill<PostingOutput>({
    skill: postingSkill,
    input,
    deps,
    outputSchema: postingOutputSchema,
    runId: traceId,
  });

  const result = results[0];
  if (!result) throw new Error(`Posting skill returned no results for draft ${draftId}`);

  const externalId = result.commentId ?? result.postId ?? null;
  const externalUrl = isX
    ? result.url ?? null
    : result.permalink
      ? `https://reddit.com${result.permalink}`
      : result.url ?? null;

  if (result.success && externalId) {
    log.info(`Posted ${draftType} ${externalId} to r/${thread.community}`);

    // Insert post record
    const [insertedPost] = await db
      .insert(posts)
      .values({
        draftId,
        userId,
        platform: thread.platform,
        externalId,
        externalUrl,
        community: thread.community,
        status: result.verified ? 'verified' : 'posted',
      })
      .returning({ id: posts.id });

    // Telemetry: stage='posted'. Upsert thread_feedback so the ground-truth
    // label for this thread reflects the terminal user disposition ('post'
    // supersedes an earlier 'approve').
    await recordPipelineEvent({
      userId,
      threadId: draft.threadId,
      draftId,
      postId: insertedPost?.id,
      stage: 'posted',
      metadata: { platform: thread.platform, externalId, draftType },
    });
    await recordThreadFeedback({
      userId,
      threadId: draft.threadId,
      userAction: 'post',
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

    // X-specific post-publish actions. Engagement monitoring is currently
    // only wired for X — when another platform grows a mentions API,
    // gate this off a platform-config capability flag instead.
    if (isX && externalId) {
      // Skip engagement monitoring for deep engagement replies
      if (draft.engagementDepth >= MAX_ENGAGEMENT_DEPTH) {
        log.info(
          `Skipping engagement monitoring for tweet ${externalId}: depth ${draft.engagementDepth} >= max ${MAX_ENGAGEMENT_DEPTH}`,
        );
      } else {
        // Schedule engagement monitoring at +15, +30, +60 minutes.
        // Pass draftId so the processor can look up the posted text directly
        // from the DB instead of shipping it in the job payload.
        for (const delayMin of [15, 30, 60]) {
          await enqueueEngagement(
            {
              userId,
              contentId: externalId,
              draftId,
              productId: '',
              platform: PLATFORMS.x.id,
              traceId,
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

    // Telemetry: terminal failure at the posting stage. Keep metadata
    // minimal to avoid leaking provider error bodies into the funnel.
    await recordPipelineEvent({
      userId,
      threadId: draft.threadId,
      draftId,
      stage: 'failed',
      metadata: {
        reason: 'post_failed',
        platform: thread.platform,
        error: result.error ?? 'unknown',
      },
    });
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
  await publishUserEvent(userId, 'agents', {
    type: result.success ? 'post_published' : 'post_failed',
    draftType,
    community: thread.community,
    shadowbanned: result.shadowbanned,
  });

  // Terminal cost roll-up for the whole discovery → content → review → posting
  // chain keyed by traceId. Safe even if earlier stages never contributed
  // (returns a zeroed snapshot).
  const runCost = await getCostForRun(traceId);
  log.info('Run cost total', {
    costUsd: runCost.costUsd,
    inputTokens: runCost.inputTokens,
    outputTokens: runCost.outputTokens,
    cacheReadTokens: runCost.cacheReadTokens,
    cacheWriteTokens: runCost.cacheWriteTokens,
    turns: runCost.turns,
    models: runCost.models,
  });
}
