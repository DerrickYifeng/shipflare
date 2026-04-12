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
import { queryOutputSchema, discoveryOutputSchema } from '@/agents/schemas';
import type { DiscoveryOutput } from '@/agents/schemas';
import { join } from 'path';
import type { DiscoveryJobData } from '@/lib/queue/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const emptyToolRegistry = new Map<string, ToolDefinition<any, any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const searchToolRegistry = new Map<string, ToolDefinition<any, any>>([
  ['reddit_search', redditSearchTool],
]);

const AGENTS_DIR = join(process.cwd(), 'src/agents');

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

  // --- Step 1: Query Agent — generate pain-point search queries ---

  const queryAgent = loadAgentFromFile(
    join(AGENTS_DIR, 'query.md'),
    emptyToolRegistry,
  );

  const queryInput = JSON.stringify({
    productName: product.name,
    productDescription: product.description,
    keywords: product.keywords,
    valueProp: product.valueProp,
    subreddits,
  });

  const { result: queryResult, usage: queryUsage } = await runAgent(
    queryAgent,
    queryInput,
    createToolContext({}),
    queryOutputSchema,
  );

  // --- Step 2: Fan out discovery agents in parallel (one per subreddit) ---

  const discoveryAgent = loadAgentFromFile(
    join(AGENTS_DIR, 'discovery.md'),
    searchToolRegistry,
  );

  const discoveryPromises = subreddits.map((subreddit) => {
    const queries = queryResult.subredditQueries[subreddit] ?? [];
    if (queries.length === 0) return Promise.resolve(null);

    const context = createToolContext({ redditClient });
    const userMessage = JSON.stringify({
      productName: product.name,
      productDescription: product.description,
      valueProp: product.valueProp,
      subreddit,
      queries,
    });

    return runAgent(discoveryAgent, userMessage, context, discoveryOutputSchema);
  });

  const discoveryResults = await Promise.all(discoveryPromises);

  // --- Step 3: Merge results, deduplicate, persist ---

  const seenIds = new Set<string>();
  const allThreads: DiscoveryOutput['threads'] = [];

  let totalInputTokens = queryUsage.inputTokens;
  let totalOutputTokens = queryUsage.outputTokens;
  let totalCost = queryUsage.costUsd;

  for (const dr of discoveryResults) {
    if (!dr) continue;
    totalInputTokens += dr.usage.inputTokens;
    totalOutputTokens += dr.usage.outputTokens;
    totalCost += dr.usage.costUsd;

    for (const thread of dr.result.threads) {
      if (seenIds.has(thread.id)) continue;
      seenIds.add(thread.id);
      allThreads.push(thread);
    }
  }

  // Insert discovered threads
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

    const relevanceScore = (thread.relevance + thread.intent) / 2;

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
      cost: totalCost,
    },
  });

  // Publish SSE event
  await publishEvent(`shipflare:events:${userId}`, {
    type: 'discovery_complete',
    threadsFound: allThreads.length,
    newThreads: newThreadCount,
  });
}
