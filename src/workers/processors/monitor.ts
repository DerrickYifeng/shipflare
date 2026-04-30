import { join } from 'path';
import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import {
  products,
  channels,
  threads,
  activityEvents,
  xTargetAccounts,
  xMonitoredTweets,
} from '@/lib/db/schema';
import { eq, and, inArray, lt } from 'drizzle-orm';
import { XClient, XForbiddenError } from '@/lib/x-client';
import { XAIClient } from '@/lib/xai-client';
import { createPlatformDeps, createPublicPlatformDeps } from '@/lib/platform-deps';
import { runAgent, createToolContext } from '@/bridge/agent-runner';
import { loadAgentFromFile } from '@/bridge/load-agent';
import { registry } from '@/tools/registry';
import { communityManagerOutputSchema } from '@/tools/AgentTool/agents/community-manager/schema';
import { enqueueDream, enqueueMonitor } from '@/lib/queue';
import { publishUserEvent, getKeyValueClient } from '@/lib/redis';
import type { MonitorJobData } from '@/lib/queue/types';
import { isFanoutJob } from '@/lib/queue/types';
import { createLogger, loggerForJob, type Logger } from '@/lib/logger';
import { buildContentUrl } from '@/lib/platform-config';
import { MemoryStore } from '@/memory/store';
import { AgentDream } from '@/memory/dream';

const baseLog = createLogger('worker:x-monitor');

const REPLY_WINDOW_MINUTES = 15;
const TWEET_MAX_AGE_MINUTES = 60;

const COMMUNITY_MANAGER_AGENT_PATH = join(
  process.cwd(),
  'src/tools/AgentTool/agents/community-manager/AGENT.md',
);

async function processXMonitorForUser(
  userId: string,
  productId: string,
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

  // Resolve X client via createPlatformDeps — sanctioned path for token-column
  // access (see CLAUDE.md → Security TODO item 2).
  const deps = await createPlatformDeps('x', userId);
  const xClient = deps.xClient as XClient | undefined;
  if (!xClient) throw new Error('No X channel connected');

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
    quotedTweetId?: string;
    quotedText?: string;
    quotedAuthorUsername?: string;
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
    quotedTweetId?: string;
    quotedText?: string;
    quotedAuthorUsername?: string;
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

      // Collect tweets within max age window, dropping replies/retweets and
      // resolving quoted-tweet context for QTs in a single batched call.
      const keptTweets: Array<{
        tweet: typeof result.tweets[number];
        tweetDate: Date;
        replyDeadline: Date;
        tweetUrl: string;
        quotedTweetId?: string;
      }> = [];
      const quotedIdsToFetch = new Set<string>();

      for (const tweet of result.tweets) {
        const tweetDate = tweet.createdAt ? new Date(tweet.createdAt) : now;
        if (tweetDate < maxAge) continue;

        const refs = tweet.referencedTweets ?? [];
        // Skip replies (low-audience, context-brittle) and retweets (not
        // original content from the target). Keeps originals and QTs.
        if (refs.some((r) => r.type === 'replied_to' || r.type === 'retweeted')) {
          continue;
        }

        const quotedRef = refs.find((r) => r.type === 'quoted');
        if (quotedRef) quotedIdsToFetch.add(quotedRef.id);

        const replyDeadline = new Date(
          tweetDate.getTime() + REPLY_WINDOW_MINUTES * 60_000,
        );
        const tweetUrl = tweet.authorUsername
          ? buildContentUrl('x', tweet.authorUsername, tweet.id)
          : buildContentUrl('x', 'i', tweet.id);

        keptTweets.push({
          tweet,
          tweetDate,
          replyDeadline,
          tweetUrl,
          quotedTweetId: quotedRef?.id,
        });
      }

      // Batch-fetch quoted sources (one API call per target, not per tweet).
      const quotedMap = new Map<
        string,
        { text: string; authorUsername?: string }
      >();
      if (quotedIdsToFetch.size > 0) {
        try {
          const quoted = await xClient.getTweets([...quotedIdsToFetch]);
          for (const qt of quoted) {
            quotedMap.set(qt.id, {
              text: qt.text,
              authorUsername: qt.authorUsername,
            });
          }
        } catch (qErr) {
          log.warn(
            `Failed to fetch quoted tweet context for @${target.username}: ${qErr}`,
          );
        }
      }

      for (const kept of keptTweets) {
        const quoted = kept.quotedTweetId
          ? quotedMap.get(kept.quotedTweetId)
          : undefined;

        candidates.push({
          tweetId: kept.tweet.id,
          tweetText: kept.tweet.text,
          authorUsername: kept.tweet.authorUsername ?? target.username,
          targetUsername: target.username,
          targetAccountId: target.id,
          tweetUrl: kept.tweetUrl,
          postedAt: kept.tweetDate,
          replyDeadline: kept.replyDeadline,
          quotedTweetId: kept.quotedTweetId,
          quotedText: quoted?.text,
          quotedAuthorUsername: quoted?.authorUsername,
        });
      }
    } catch (err) {
      if (err instanceof XForbiddenError) {
        log.warn(
          `X API 403 for @${target.username} — Basic tier required for getUserTweets. Falling back to Grok search.`,
        );
        try {
          const publicDeps = createPublicPlatformDeps(['x']);
          const xaiClient = publicDeps.xaiClient as XAIClient | undefined;
          if (!xaiClient) {
            // Preserve the old `new XAIClient()` throw-on-missing-env behavior
            // so the outer fallbackErr catch handles it identically.
            throw new Error('XAI_API_KEY is required');
          }
          // Grok search doesn't return referenced_tweets metadata, so we
          // rely on X search operators to exclude replies/retweets. Best-effort.
          const searchResult = await xaiClient.searchTweets(
            `from:${target.username} -is:retweet -is:reply`,
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
            quotedTweetId: c.quotedTweetId,
            quotedText: c.quotedText,
            quotedAuthorUsername: c.quotedAuthorUsername,
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

  // Run unified reply pipeline for tweets within the reply window. Same
  // agent (community-manager) the coordinator-driven /api/automation/run
  // path uses — single rule set, single INSERT entry point.
  if (tweetsForReply.length > 0) {
    const memoryStore = new MemoryStore(userId, productId);
    const dream = new AgentDream(memoryStore);

    // Insert a thread row per tweet up front so community-manager can
    // resolve `threadId` and call `draft_reply` against it. Persist the
    // full tweet body so the agent can read it without an extra fetch.
    const insertedThreads = await Promise.all(
      tweetsForReply.map(async (t) => {
        const [row] = await db
          .insert(threads)
          .values({
            userId,
            externalId: t.tweetId,
            platform: 'x',
            community: `@${t.authorUsername}`,
            title: t.tweetText.slice(0, 200),
            body: t.tweetText,
            author: t.authorUsername,
            url: buildContentUrl('x', t.authorUsername, t.tweetId),
            scoutReason: 'monitor-window',
          })
          .onConflictDoNothing()
          .returning();
        return { tweet: t, threadRow: row };
      }),
    );

    const agentConfig = loadAgentFromFile(
      COMMUNITY_MANAGER_AGENT_PATH,
      registry.toMap(),
    );

    const perTweetResults = await Promise.all(
      insertedThreads.map(async ({ tweet, threadRow }) => {
        if (!threadRow) {
          // Thread already existed (duplicate tweetId) — nothing to do.
          return { drafted: false, skipped: true };
        }

        const quotedBlock =
          tweet.quotedText && tweet.quotedAuthorUsername
            ? `\n\nQuote tweet — author is reacting to:\n- quoted author: @${tweet.quotedAuthorUsername}\n- quoted text: ${tweet.quotedText}`
            : '';

        const spawnPrompt =
          `Ad-hoc reply slot from X monitor sweep.\n\n` +
          `Thread:\n` +
          `- threadId: ${threadRow.id}\n` +
          `- platform: x\n` +
          `- url: ${threadRow.url}\n` +
          `- author: @${tweet.authorUsername}\n` +
          `- text: ${tweet.tweetText}` +
          quotedBlock +
          `\n\nProduct context:\n` +
          `- name: ${tweet.productName}\n` +
          `- description: ${tweet.productDescription}\n` +
          `- valueProp: ${tweet.valueProp}\n\n` +
          `Apply the three-gate test in reply-quality-bar.md. If the ` +
          `thread passes, draft one reply via draft_reply against this ` +
          `threadId. If it fails any gate, skip and emit StructuredOutput ` +
          `with draftsCreated=0.`;

        try {
          const { result } = await runAgent(
            agentConfig,
            spawnPrompt,
            createToolContext({ userId, productId }),
            communityManagerOutputSchema,
          );
          const drafted = (result?.draftsCreated ?? 0) > 0;
          await db
            .update(xMonitoredTweets)
            .set({ status: drafted ? 'draft_created' : 'skipped' })
            .where(
              and(
                eq(xMonitoredTweets.userId, userId),
                eq(xMonitoredTweets.tweetId, tweet.tweetId),
              ),
            );
          return { drafted, skipped: !drafted };
        } catch (err) {
          log.warn(
            `community-manager failed for tweet ${tweet.tweetId}: ${(err as Error).message}`,
          );
          return { drafted: false, skipped: true };
        }
      }),
    );

    const draftsCreated = perTweetResults.filter((r) => r.drafted).length;

    log.info(`Created ${draftsCreated} reply drafts via community-manager`);

    // Publish SSE event
    await publishUserEvent(userId, 'tweets', {
      type: 'agent_complete',
      agentName: 'community-manager',
      stats: {
        tweetsScanned: totalNewTweets,
        withinWindow: tweetsForReply.length,
        draftsCreated,
      },
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
  await processXMonitorForUser(userId, productId, log);
}
