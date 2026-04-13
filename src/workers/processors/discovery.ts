import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { products, threads, activityEvents } from '@/lib/db/schema';
import { channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { RedditClient } from '@/lib/reddit-client';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { discoveryOutputSchema } from '@/agents/schemas';
import type { DiscoveryOutput } from '@/agents/schemas';
import { enqueueContent, enqueueDream } from '@/lib/queue';
import { publishEvent } from '@/lib/redis';
import { join } from 'path';
import type { DiscoveryJobData } from '@/lib/queue/types';
import { createLogger } from '@/lib/logger';
import { MemoryStore } from '@/memory/store';
import { AgentDream } from '@/memory/dream';
import { buildMemoryPrompt } from '@/memory/prompt-builder';

const log = createLogger('worker:discovery');

const discoverySkill = loadSkill(
  join(process.cwd(), 'src/skills/discovery'),
);

export async function processDiscovery(job: Job<DiscoveryJobData>) {
  const { userId, productId, subreddits } = job.data;
  log.info(`Starting discovery for product ${productId}, ${subreddits.length} subreddits`);

  // Load product
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!product) throw new Error(`Product not found: ${productId}`);

  // Load Reddit channel
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.userId, userId), eq(channels.platform, 'reddit')))
    .limit(1);

  if (!channel) throw new Error('No Reddit channel connected');

  const redditClient = RedditClient.fromChannel(channel);

  // Load memory context
  const memoryStore = new MemoryStore(productId);
  const dream = new AgentDream(memoryStore);
  const memoryPrompt = await buildMemoryPrompt(memoryStore);

  // Run discovery skill (fan-out across subreddits, cache-safe)
  const result = await runSkill<DiscoveryOutput>({
    skill: discoverySkill,
    input: {
      productName: product.name,
      productDescription: product.description,
      keywords: product.keywords,
      valueProp: product.valueProp,
      subreddits,
    },
    deps: { redditClient },
    memoryPrompt: memoryPrompt || undefined,
    outputSchema: discoveryOutputSchema,
  });

  // Merge and deduplicate threads
  const seenIds = new Set<string>();
  const allThreads: DiscoveryOutput['threads'] = [];

  for (const discovery of result.results) {
    for (const thread of discovery.threads) {
      if (seenIds.has(thread.id)) continue;
      seenIds.add(thread.id);
      allThreads.push(thread);
    }
  }

  log.info(`Discovery found ${allThreads.length} threads across ${subreddits.length} subreddits, cost $${result.usage.costUsd.toFixed(4)}`);

  for (const err of result.errors) {
    log.warn(`Agent failed for r/${err.label}: ${err.error}`);
  }

  // Persist threads
  let newThreadCount = 0;
  for (const thread of allThreads) {
    const existing = await db
      .select()
      .from(threads)
      .where(
        and(eq(threads.userId, userId), eq(threads.externalId, thread.id)),
      )
      .limit(1);

    if (existing.length > 0) continue;

    const relevanceScore = thread.relevanceScore != null
      ? thread.relevanceScore / 100
      : ((thread.relevance ?? 0) + (thread.intent ?? 0)) / 2;

    const [inserted] = await db
      .insert(threads)
      .values({
        userId,
        externalId: thread.id,
        subreddit: thread.subreddit,
        title: thread.title,
        url: thread.url,
        relevanceScore,
      })
      .returning();

    newThreadCount++;

    // Auto-enqueue content for high-relevance threads
    if (relevanceScore >= 0.7 && inserted) {
      log.debug(`Auto-enqueuing content for thread ${inserted.id} (relevance ${relevanceScore.toFixed(2)})`);
      await enqueueContent({
        userId,
        threadId: inserted.id,
        productId,
      });
    }
  }

  // Log activity
  await db.insert(activityEvents).values({
    userId,
    eventType: 'discovery_scan',
    metadataJson: {
      subreddits,
      threadsFound: allThreads.length,
      newThreads: newThreadCount,
      cost: result.usage.costUsd,
    },
  });

  // Publish SSE event
  await publishEvent(`shipflare:events:${userId}`, {
    type: 'discovery_complete',
    threadsFound: allThreads.length,
    newThreads: newThreadCount,
  });

  // Memory: log insights from this discovery run
  const topSubreddits = subreddits
    .map((sub) => {
      const count = allThreads.filter((t) => t.subreddit === sub).length;
      return { sub, count };
    })
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count);

  if (topSubreddits.length > 0) {
    const summary = topSubreddits.map((s) => `r/${s.sub}: ${s.count} threads`).join(', ');
    await dream.logInsight(`Discovery scan found ${allThreads.length} threads (${newThreadCount} new). ${summary}`);
  }

  for (const err of result.errors) {
    await dream.logInsight(`Discovery agent failed for r/${err.label}: ${err.error}`);
  }

  // Check if distillation should be triggered
  if (await dream.shouldDistill()) {
    await enqueueDream({ productId });
  }
}
