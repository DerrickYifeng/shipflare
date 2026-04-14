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
} from '@/lib/db/schema';
import { eq, and, gt } from 'drizzle-orm';
import { XClient, XForbiddenError } from '@/lib/x-client';
import { XAIClient } from '@/lib/xai-client';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { replyDrafterOutputSchema } from '@/agents/schemas';
import type { ReplyDrafterOutput } from '@/agents/schemas';
import { enqueueReview, enqueueDream } from '@/lib/queue';
import { publishEvent } from '@/lib/redis';
import { getRedis } from '@/lib/redis';
import { join } from 'path';
import type { XMonitorJobData } from '@/lib/queue/types';
import { createLogger } from '@/lib/logger';
import { MemoryStore } from '@/memory/store';
import { AgentDream } from '@/memory/dream';
import { buildMemoryPrompt } from '@/memory/prompt-builder';

const log = createLogger('worker:x-monitor');

const replyScanSkill = loadSkill(
  join(process.cwd(), 'src/skills/reply-scan'),
);

const REPLY_WINDOW_MINUTES = 15;
const TWEET_MAX_AGE_MINUTES = 60;

async function processXMonitorForUser(userId: string, productId: string) {
  log.info(`Starting X monitor scan for user ${userId}`);

  // Load product
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!product) throw new Error(`Product not found: ${productId}`);

  // Load X channel
  const [xChannel] = await db
    .select()
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

  const redis = getRedis();
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

        // Check if already tracked
        const existing = await db
          .select()
          .from(xMonitoredTweets)
          .where(
            and(
              eq(xMonitoredTweets.userId, userId),
              eq(xMonitoredTweets.tweetId, tweet.id),
            ),
          )
          .limit(1);

        if (existing.length > 0) continue;

        const replyDeadline = new Date(
          tweetDate.getTime() + REPLY_WINDOW_MINUTES * 60_000,
        );

        const tweetUrl = tweet.authorUsername
          ? `https://x.com/${tweet.authorUsername}/status/${tweet.id}`
          : `https://x.com/i/status/${tweet.id}`;

        // Insert monitored tweet
        await db.insert(xMonitoredTweets).values({
          userId,
          targetAccountId: target.id,
          tweetId: tweet.id,
          tweetText: tweet.text,
          authorUsername: tweet.authorUsername ?? target.username,
          tweetUrl,
          postedAt: tweetDate,
          replyDeadline,
        });

        totalNewTweets++;

        // Queue for reply if within reply window
        if (replyDeadline > now) {
          tweetsForReply.push({
            tweetId: tweet.id,
            tweetText: tweet.text,
            authorUsername: tweet.authorUsername ?? target.username,
            productName: product.name,
            productDescription: product.description,
            valueProp: product.valueProp ?? '',
            keywords: product.keywords,
          });
        }
      }
    } catch (err) {
      if (err instanceof XForbiddenError) {
        log.warn(
          `X API 403 for @${target.username} — Basic tier required for getUserTweets. Falling back to Grok search.`,
        );
        // Fallback: use xAI Grok search for this account
        try {
          const xaiClient = new XAIClient();
          const searchResult = await xaiClient.searchTweets(
            `from:${target.username}`,
            { maxResults: 5 },
          );
          for (const tweet of searchResult.tweets) {
            const existing = await db
              .select()
              .from(xMonitoredTweets)
              .where(
                and(
                  eq(xMonitoredTweets.userId, userId),
                  eq(xMonitoredTweets.tweetId, tweet.tweetId),
                ),
              )
              .limit(1);

            if (existing.length > 0) continue;

            const replyDeadline = new Date(
              now.getTime() + REPLY_WINDOW_MINUTES * 60_000,
            );

            await db.insert(xMonitoredTweets).values({
              userId,
              targetAccountId: target.id,
              tweetId: tweet.tweetId,
              tweetText: tweet.text,
              authorUsername: tweet.authorUsername ?? target.username,
              tweetUrl: tweet.url,
              postedAt: now,
              replyDeadline,
            });

            totalNewTweets++;
            tweetsForReply.push({
              tweetId: tweet.tweetId,
              tweetText: tweet.text,
              authorUsername: tweet.authorUsername ?? target.username,
              productName: product.name,
              productDescription: product.description,
              valueProp: product.valueProp ?? '',
              keywords: product.keywords,
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

  log.info(`Found ${totalNewTweets} new tweets, ${tweetsForReply.length} within reply window`);

  // Expire old tweets past deadline
  const expiredTweets = await db
    .select()
    .from(xMonitoredTweets)
    .where(
      and(
        eq(xMonitoredTweets.userId, userId),
        eq(xMonitoredTweets.status, 'pending'),
      ),
    );

  for (const tweet of expiredTweets) {
    if (tweet.replyDeadline < now) {
      await db
        .update(xMonitoredTweets)
        .set({ status: 'expired' })
        .where(eq(xMonitoredTweets.id, tweet.id));
    }
  }

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
          url: `https://x.com/${tweetInput.authorUsername}/status/${tweetInput.tweetId}`,
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

export async function processXMonitor(job: Job<XMonitorJobData>) {
  const { userId, productId } = job.data;

  if (userId === '__all__') {
    // Cron fan-out: find all users with an active X channel and process each
    const xChannels = await db
      .select({ userId: channels.userId })
      .from(channels)
      .where(eq(channels.platform, 'x'));

    const userIds = [...new Set(xChannels.map((c) => c.userId))];
    log.info(`Cron fan-out: processing ${userIds.length} users with X channels`);

    for (const uid of userIds) {
      const [userProduct] = await db
        .select()
        .from(products)
        .where(eq(products.userId, uid))
        .limit(1);

      if (!userProduct) {
        log.warn(`No product found for user ${uid}, skipping`);
        continue;
      }

      try {
        await processXMonitorForUser(uid, userProduct.id);
      } catch (err) {
        log.error(`X monitor failed for user ${uid}: ${err}`);
      }
    }
    return;
  }

  await processXMonitorForUser(userId, productId);
}
