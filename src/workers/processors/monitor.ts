import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import {
  products,
  channels,
  drafts,
  threads,
  activityEvents,
  xTargetAccounts,
  xMonitoredTweets,
  todoItems,
} from '@/lib/db/schema';
import { eq, and, inArray, lt } from 'drizzle-orm';
import { XClient, XForbiddenError } from '@/lib/x-client';
import { XAIClient } from '@/lib/xai-client';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { replyDrafterOutputSchema } from '@/agents/schemas';
import type { ReplyDrafterOutput } from '@/agents/schemas';
import { enqueueReview, enqueueDream, enqueueMonitor } from '@/lib/queue';
import { publishEvent, getKeyValueClient } from '@/lib/redis';
import { join } from 'path';
import type { MonitorJobData } from '@/lib/queue/types';
import { isFanoutJob, getTraceId } from '@/lib/queue/types';
import { createLogger, loggerForJob, type Logger } from '@/lib/logger';
import { buildContentUrl } from '@/lib/platform-config';
import { MemoryStore } from '@/memory/store';
import { AgentDream } from '@/memory/dream';
import { buildMemoryPrompt } from '@/memory/prompt-builder';

const baseLog = createLogger('worker:x-monitor');

const replyScanSkill = loadSkill(
  join(process.cwd(), 'src/skills/reply-scan'),
);

const REPLY_WINDOW_MINUTES = 15;
const TWEET_MAX_AGE_MINUTES = 60;

async function processXMonitorForUser(
  userId: string,
  productId: string,
  traceId: string,
  log: Logger,
) {
  log.info(`Starting X monitor scan for user ${userId}`);

  // Load product
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!product) throw new Error(`Product not found: ${productId}`);

  // Load X channel — explicit projection for XClient.fromChannel
  const [xChannel] = await db
    .select({
      id: channels.id,
      oauthTokenEncrypted: channels.oauthTokenEncrypted,
      refreshTokenEncrypted: channels.refreshTokenEncrypted,
      tokenExpiresAt: channels.tokenExpiresAt,
    })
    .from(channels)
    .where(and(eq(channels.userId, userId), eq(channels.platform, 'x')))
    .limit(1);

  if (!xChannel) throw new Error('No X channel connected');

  const xClient = XClient.fromChannel(xChannel);

  // Load active target accounts
  const targets = await db
    .select()
    .from(xTargetAccounts)
    .where(
      and(
        eq(xTargetAccounts.userId, userId),
        eq(xTargetAccounts.isActive, true),
      ),
    );

  if (targets.length === 0) {
    log.info('No active target accounts, skipping');
    return;
  }

  const redis = getKeyValueClient();
  const now = new Date();
  const maxAge = new Date(now.getTime() - TWEET_MAX_AGE_MINUTES * 60_000);
  let totalNewTweets = 0;
  const tweetsForReply: Array<{
    tweetId: string;
    tweetText: string;
    authorUsername: string;
    productName: string;
    productDescription: string;
    valueProp: string;
    keywords: string[];
  }> = [];

  // Collect raw tweets from all target accounts first (per-target API calls
  // must remain sequential to respect per-target sinceId cursors and rate
  // limits), then run a single batched dedupe + bulk insert at the end.
  type CandidateTweet = {
    tweetId: string;
    tweetText: string;
    authorUsername: string;
    targetUsername: string;
    targetAccountId: string;
    tweetUrl: string;
    postedAt: Date;
    replyDeadline: Date;
  };
  const candidates: CandidateTweet[] = [];

  // Poll each target account for new tweets
  for (const target of targets) {
    if (!target.xUserId) {
      log.warn(`Target @${target.username} has no xUserId, skipping`);
      continue;
    }

    const sinceKey = `shipflare:x-monitor:${userId}:${target.xUserId}:sinceId`;
    const sinceId = await redis.get(sinceKey);

    try {
      const result = await xClient.getUserTweets(target.xUserId, {
        sinceId: sinceId ?? undefined,
        maxResults: 10,
      });

      // Store newest ID for next poll
      if (result.newestId) {
        await redis.set(sinceKey, result.newestId);
      }

      // Filter tweets within max age window
      for (const tweet of result.tweets) {
        const tweetDate = tweet.createdAt ? new Date(tweet.createdAt) : now;
        if (tweetDate < maxAge) continue;

        const replyDeadline = new Date(
          tweetDate.getTime() + REPLY_WINDOW_MINUTES * 60_000,
        );

        const tweetUrl = tweet.authorUsername
          ? buildContentUrl('x', tweet.authorUsername, tweet.id)
          : buildContentUrl('x', 'i', tweet.id);

        candidates.push({
          tweetId: tweet.id,
          tweetText: tweet.text,
          authorUsername: tweet.authorUsername ?? target.username,
          targetUsername: target.username,
          targetAccountId: target.id,
          tweetUrl,
          postedAt: tweetDate,
          replyDeadline,
        });
      }
    } catch (err) {
      if (err instanceof XForbiddenError) {
        log.warn(
          `X API 403 for @${target.username} — Basic tier required for getUserTweets. Falling back to Grok search.`,
        );
        try {
          const xaiClient = new XAIClient();
          const searchResult = await xaiClient.searchTweets(
            `from:${target.username}`,
            { maxResults: 5 },
          );
          const replyDeadline = new Date(
            now.getTime() + REPLY_WINDOW_MINUTES * 60_000,
          );
          for (const tweet of searchResult.tweets) {
            candidates.push({
              tweetId: tweet.tweetId,
              tweetText: tweet.text,
              authorUsername: tweet.authorUsername ?? target.username,
              targetUsername: target.username,
              targetAccountId: target.id,
              tweetUrl: tweet.url,
              postedAt: now,
              replyDeadline,
            });
          }
        } catch (fallbackErr) {
          log.error(`Grok fallback also failed for @${target.username}: ${fallbackErr}`);
        }
      } else {
        log.error(`Failed to fetch tweets for @${target.username}: ${err}`);
      }
    }
  }

  // Batched dedupe: one SELECT for all candidate tweet IDs
  if (candidates.length > 0) {
    const candidateIds = [...new Set(candidates.map((c) => c.tweetId))];
    const existingRows = await db
      .select({ tweetId: xMonitoredTweets.tweetId })
      .from(xMonitoredTweets)
      .where(
        and(
          eq(xMonitoredTweets.userId, userId),
          inArray(xMonitoredTweets.tweetId, candidateIds),
        ),
      );
    const existingSet = new Set(existingRows.map((r) => r.tweetId));

    const newCandidates = candidates.filter(
      (c) => !existingSet.has(c.tweetId),
    );

    if (newCandidates.length > 0) {
      const insertRows = newCandidates.map((c) => ({
        userId,
        targetAccountId: c.targetAccountId,
        tweetId: c.tweetId,
        tweetText: c.tweetText,
        authorUsername: c.authorUsername,
        tweetUrl: c.tweetUrl,
        postedAt: c.postedAt,
        replyDeadline: c.replyDeadline,
      }));

      await db
        .insert(xMonitoredTweets)
        .values(insertRows)
        .onConflictDoNothing();

      totalNewTweets += newCandidates.length;

      for (const c of newCandidates) {
        if (c.replyDeadline > now) {
          tweetsForReply.push({
            tweetId: c.tweetId,
            tweetText: c.tweetText,
            authorUsername: c.authorUsername,
            productName: product.name,
            productDescription: product.description,
            valueProp: product.valueProp ?? '',
            keywords: product.keywords,
          });
        }
      }
    }
  }

  log.info(`Found ${totalNewTweets} new tweets, ${tweetsForReply.length} within reply window`);

  // Expire old tweets past deadline in a single UPDATE
  await db
    .update(xMonitoredTweets)
    .set({ status: 'expired' })
    .where(
      and(
        eq(xMonitoredTweets.userId, userId),
        eq(xMonitoredTweets.status, 'pending'),
        lt(xMonitoredTweets.replyDeadline, now),
      ),
    );

  // Run reply-scan skill for tweets within reply window
  if (tweetsForReply.length > 0) {
    const memoryStore = new MemoryStore(productId);
    const dream = new AgentDream(memoryStore);
    const memoryPrompt = await buildMemoryPrompt(memoryStore);

    const result = await runSkill<ReplyDrafterOutput>({
      skill: replyScanSkill,
      input: { tweets: tweetsForReply },
      deps: { xClient },
      memoryPrompt: memoryPrompt || undefined,
      outputSchema: replyDrafterOutputSchema,
      runId: traceId,
    });

    let draftsCreated = 0;

    for (let i = 0; i < result.results.length; i++) {
      const replyOutput = result.results[i];
      const tweetInput = tweetsForReply[i];

      if (replyOutput.confidence < 0.5) {
        log.debug(`Skipping low-confidence reply for tweet ${tweetInput.tweetId}`);
        continue;
      }

      // Create a thread record for this monitored tweet (reuses existing draft pipeline)
      const [threadRecord] = await db
        .insert(threads)
        .values({
          userId,
          externalId: tweetInput.tweetId,
          platform: 'x',
          community: `@${tweetInput.authorUsername}`,
          title: tweetInput.tweetText.slice(0, 200),
          url: buildContentUrl('x', tweetInput.authorUsername, tweetInput.tweetId),
          relevanceScore: replyOutput.confidence,
        })
        .onConflictDoNothing()
        .returning();

      if (!threadRecord) continue;

      // Create draft
      const [draft] = await db
        .insert(drafts)
        .values({
          userId,
          threadId: threadRecord.id,
          draftType: 'reply',
          replyBody: replyOutput.replyText,
          confidenceScore: replyOutput.confidence,
          whyItWorks: replyOutput.whyItWorks,
        })
        .returning();

      draftsCreated++;

      // Update monitored tweet status
      await db
        .update(xMonitoredTweets)
        .set({ status: 'draft_created' })
        .where(
          and(
            eq(xMonitoredTweets.userId, userId),
            eq(xMonitoredTweets.tweetId, tweetInput.tweetId),
          ),
        );

      // Auto-enqueue review
      await enqueueReview({
        userId,
        draftId: draft.id,
        productId,
        traceId,
      });

      // Inject time-sensitive todo item for the Today page
      await db
        .insert(todoItems)
        .values({
          userId,
          draftId: draft.id,
          todoType: 'reply_thread',
          source: 'discovery',
          priority: 'time_sensitive',
          title: `Reply to @${tweetInput.authorUsername}: ${tweetInput.tweetText.slice(0, 80)}...`,
          platform: 'x',
          community: `@${tweetInput.authorUsername}`,
          externalUrl: buildContentUrl('x', tweetInput.authorUsername, tweetInput.tweetId),
          confidence: replyOutput.confidence,
          expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
        })
        .onConflictDoNothing();

      await publishEvent(`shipflare:events:${userId}`, {
        type: 'todo_added',
        todoType: 'reply_thread',
      });
    }

    log.info(
      `Created ${draftsCreated} reply drafts, cost $${result.usage.costUsd.toFixed(4)}`,
    );

    // Publish SSE event
    await publishEvent(`shipflare:events:${userId}`, {
      type: 'agent_complete',
      agentName: 'reply-drafter',
      stats: {
        tweetsScanned: totalNewTweets,
        withinWindow: tweetsForReply.length,
        draftsCreated,
      },
      cost: result.usage.costUsd,
    });

    // Memory
    await dream.logInsight(
      `X monitor: scanned ${targets.length} targets, found ${totalNewTweets} new tweets, ` +
      `${tweetsForReply.length} within reply window, created ${draftsCreated} reply drafts`,
    );

    if (await dream.shouldDistill()) {
      await enqueueDream({ productId });
    }
  }

  // Log activity
  await db.insert(activityEvents).values({
    userId,
    eventType: 'x_monitor_scan',
    metadataJson: {
      targetsScanned: targets.length,
      newTweets: totalNewTweets,
      repliesQueued: tweetsForReply.length,
    },
  });
}

export async function processXMonitor(job: Job<MonitorJobData>) {
  const traceId = getTraceId(job.data, job.id);
  const log = loggerForJob(baseLog, job);
  if (isFanoutJob(job.data)) {
    const platform = (job.data as { platform?: string }).platform ?? 'x';
    // Cron fan-out: enqueue per-user monitor jobs so concurrency works.
    const xChannels = await db
      .select({ userId: channels.userId })
      .from(channels)
      .where(eq(channels.platform, platform));

    const userIds = [...new Set(xChannels.map((c) => c.userId))];
    log.info(
      `Cron fan-out: enqueueing ${userIds.length} per-user monitor jobs (${platform})`,
    );

    let enqueued = 0;
    for (const uid of userIds) {
      const [userProduct] = await db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.userId, uid))
        .limit(1);

      if (!userProduct) {
        log.warn(`No product found for user ${uid}, skipping`);
        continue;
      }

      await enqueueMonitor({
        userId: uid,
        productId: userProduct.id,
        platform,
      });
      enqueued++;
    }
    log.info(`Cron fan-out enqueued ${enqueued} monitor jobs`);
    return;
  }

  const data = job.data as Extract<MonitorJobData, { userId: string }>;
  const { userId, productId } = data;
  await processXMonitorForUser(userId, productId, traceId, log);
}
