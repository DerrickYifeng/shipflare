import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { drafts, posts, threads, activityEvents, planItems } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { RedditClient } from '@/lib/reddit-client';
import { XClient } from '@/lib/x-client';
import { createClientFromChannelById } from '@/lib/platform-deps';
import { PLATFORMS } from '@/lib/platform-config';
import { runAgent, createToolContext } from '@/bridge/agent-runner';
import { loadAgentFromFile } from '@/bridge/load-agent';
import { registry } from '@/tools/registry';
import { isCircuitBreakerTripped, tripCircuitBreaker } from '@/lib/circuit-breaker';
import { canPostToSubreddit } from '@/lib/rate-limiter';
import { enqueueEngagement } from '@/lib/queue';
import { publishUserEvent } from '@/lib/redis';
import { join } from 'path';
import type { PostingJobData } from '@/lib/queue/types';
import { getTraceId } from '@/lib/queue/types';
import type { UsageSummary } from '@/core/types';
import { postingOutputSchema } from '@/agents/schemas';
import { createLogger, loggerForJob } from '@/lib/logger';
import { addCost, getCostForRun } from '@/lib/cost-bucket';
import { recordPipelineEvent, recordThreadFeedback } from '@/lib/pipeline-events';

const MAX_ENGAGEMENT_DEPTH = 2;
const baseLog = createLogger('worker:posting');

const POSTING_AGENT_PATH = join(
  process.cwd(),
  'src/tools/AgentTool/agents/posting/AGENT.md',
);

// ---------------------------------------------------------------------------
// Direct-mode posting (no agent, straight platform-client calls)
// ---------------------------------------------------------------------------

interface DirectModeArgs {
  platform: string;
  draftType: 'reply' | 'original_post';
  draftText: string;
  threadExternalId: string | null;
  threadCommunity: string;
  postTitle: string | null;
  client: XClient | RedditClient;
}

export interface DirectModeResult {
  success: boolean;
  externalId: string | null;
  externalUrl: string | null;
  shadowbanned: boolean;
  error?: string;
}

/**
 * Direct-mode posting: skip the agent, call the platform client straight.
 * Used by manual user approve and plan-execute auto-approve. Caller is
 * responsible for circuit-breaker / rate-limit checks BEFORE calling this.
 */
export async function postViaDirectMode(
  args: DirectModeArgs,
): Promise<DirectModeResult> {
  const isX = args.platform === PLATFORMS.x.id;
  try {
    if (isX) {
      if (!(args.client instanceof XClient)) {
        throw new Error('postViaDirectMode: X platform requires an XClient instance');
      }
      if (args.draftType === 'reply') {
        if (!args.threadExternalId) {
          throw new Error('X reply requires threadExternalId');
        }
        const r = await args.client.replyToTweet(args.threadExternalId, args.draftText);
        return { success: true, externalId: r.tweetId, externalUrl: r.url, shadowbanned: false };
      }
      const r = await args.client.postTweet(args.draftText);
      return { success: true, externalId: r.tweetId, externalUrl: r.url, shadowbanned: false };
    }

    // Reddit
    if (!(args.client instanceof RedditClient)) {
      throw new Error('postViaDirectMode: Reddit platform requires a RedditClient instance');
    }
    if (args.draftType === 'reply') {
      if (!args.threadExternalId) {
        throw new Error('Reddit reply requires threadExternalId');
      }
      const r = await args.client.postComment(`t3_${args.threadExternalId}`, args.draftText);
      return {
        success: true,
        externalId: r.id,
        externalUrl: `https://reddit.com${r.permalink}`,
        shadowbanned: false,
      };
    }
    if (!args.postTitle) {
      throw new Error('Reddit original_post requires postTitle');
    }
    const r = await args.client.submitPost(args.threadCommunity, args.postTitle, args.draftText);
    return {
      success: true,
      externalId: r.id,
      externalUrl: r.url,
      shadowbanned: false,
    };
  } catch (err) {
    return {
      success: false,
      externalId: null,
      externalUrl: null,
      shadowbanned: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

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

  // Resolve client + platform via the sanctioned helper. Token-column
  // projection stays inside platform-deps.ts; processor never sees it.
  const resolved = await createClientFromChannelById(channelId);
  if (!resolved) {
    throw new Error(`Channel not found or unsupported platform: ${channelId}`);
  }
  const { client, platform } = resolved;

  const isX = platform === PLATFORMS.x.id;
  const draftType = draft.draftType ?? 'reply';

  // Build input for the posting skill
  const input: Record<string, unknown> = {
    platform,
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

  const deps: Record<string, unknown> = client instanceof XClient
    ? { xClient: client }
    : client instanceof RedditClient
      ? { redditClient: client }
      : {};

  let result: {
    success: boolean;
    externalId?: string | null;
    externalUrl?: string | null;
    shadowbanned: boolean;
    commentId?: string | null;
    postId?: string | null;
    permalink?: string | null;
    url?: string | null;
    error?: string;
    verified?: boolean;
    draftType?: string;
  };
  const zeroUsage: UsageSummary = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model: '',
    turns: 0,
  };
  let usage: UsageSummary = zeroUsage;

  const mode = job.data.mode ?? 'agent';
  if (mode === 'direct') {
    const direct = await postViaDirectMode({
      platform,
      draftType: draftType as 'reply' | 'original_post',
      draftText: draft.replyBody,
      threadExternalId: thread.externalId,
      threadCommunity: thread.community,
      postTitle: draft.postTitle ?? null,
      client,
    });
    result = {
      success: direct.success,
      externalId: direct.externalId,
      externalUrl: direct.externalUrl,
      shadowbanned: direct.shadowbanned,
      commentId: direct.externalId,
      postId: direct.externalId,
      permalink: null,
      url: direct.externalUrl,
      verified: false,
      error: direct.error,
    };
  } else {
    const agentConfig = loadAgentFromFile(POSTING_AGENT_PATH, registry.toMap());
    const context = createToolContext(deps);
    const agentRun = await runAgent(
      agentConfig,
      JSON.stringify(input),
      context,
      postingOutputSchema,
    );
    result = agentRun.result;
    usage = agentRun.usage;
  }
  await addCost(traceId, usage);

  const externalId = result.externalId ?? result.commentId ?? result.postId ?? null;
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

    // If this draft was created from a plan_item, mark the plan_item completed
    // so Today and the calendar reflect the terminal state immediately.
    if (draft.planItemId) {
      await db
        .update(planItems)
        .set({ state: 'completed', updatedAt: new Date(), completedAt: new Date() })
        .where(eq(planItems.id, draft.planItemId));
    }

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

    // If this draft was created from a plan_item, mark the plan_item failed
    // so Today and the calendar reflect the terminal state immediately.
    if (draft.planItemId) {
      await db
        .update(planItems)
        .set({ state: 'failed', updatedAt: new Date() })
        .where(eq(planItems.id, draft.planItemId));
    }

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
