import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { products, threads, activityEvents } from '@/lib/db/schema';
import { channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { RedditClient } from '@/lib/reddit-client';
import { runAgent, createToolContext } from '@/bridge/agent-runner';
import { loadAgentFromFile } from '@/bridge/load-agent';
import { redditSearchTool } from '@/tools/reddit-search';
import type { ToolDefinition } from '@/bridge/types';
import { enqueueContent } from '@/lib/queue';
import { publishEvent } from '@/lib/redis';
import { join } from 'path';
import { z } from 'zod';
import type { DiscoveryJobData } from '@/lib/queue/types';

const discoveryOutputSchema = z.object({
  threads: z.array(
    z.object({
      id: z.string(),
      subreddit: z.string(),
      title: z.string(),
      url: z.string(),
      relevanceScore: z.number(),
      reason: z.string(),
    }),
  ),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toolRegistry = new Map<string, ToolDefinition<any, any>>([['reddit_search', redditSearchTool]]);

export async function processDiscovery(job: Job<DiscoveryJobData>) {
  const { userId, productId, subreddits } = job.data;

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

  // Load agent definition
  const agentConfig = loadAgentFromFile(
    join(process.cwd(), 'src/agents/discovery.md'),
    toolRegistry,
  );

  // Build context with DI
  const context = createToolContext({ redditClient });

  // Run discovery agent
  const userMessage = JSON.stringify({
    productName: product.name,
    productDescription: product.description,
    keywords: product.keywords,
    valueProp: product.valueProp,
    subreddits,
  });

  const { result, usage } = await runAgent(
    agentConfig,
    userMessage,
    context,
    discoveryOutputSchema,
  );

  // Insert discovered threads, skip duplicates
  let newThreadCount = 0;
  for (const thread of result.threads) {
    // Check for existing thread with same external ID
    const existing = await db
      .select()
      .from(threads)
      .where(
        and(eq(threads.userId, userId), eq(threads.externalId, thread.id)),
      )
      .limit(1);

    if (existing.length > 0) continue;

    const [inserted] = await db
      .insert(threads)
      .values({
        userId,
        externalId: thread.id,
        subreddit: thread.subreddit,
        title: thread.title,
        url: thread.url,
        relevanceScore: thread.relevanceScore,
      })
      .returning();

    newThreadCount++;

    // Auto-enqueue content for high-relevance threads
    if (thread.relevanceScore >= 0.7 && inserted) {
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
      threadsFound: result.threads.length,
      newThreads: newThreadCount,
      cost: usage.costUsd,
    },
  });

  // Publish SSE event
  await publishEvent(`shipflare:events:${userId}`, {
    type: 'discovery_complete',
    threadsFound: result.threads.length,
    newThreads: newThreadCount,
  });
}
