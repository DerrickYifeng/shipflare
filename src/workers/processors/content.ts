import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { products, threads, drafts, activityEvents } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { runAgent, createToolContext } from '@/bridge/agent-runner';
import { loadAgentFromFile } from '@/bridge/load-agent';
import { publishEvent } from '@/lib/redis';
import { join } from 'path';
import { z } from 'zod';
import type { ContentJobData } from '@/lib/queue/types';

const contentOutputSchema = z.object({
  replyBody: z.string(),
  confidence: z.number(),
  whyItWorks: z.string(),
  ftcDisclosure: z.string(),
});

export async function processContent(job: Job<ContentJobData>) {
  const { userId, threadId, productId } = job.data;

  // Load thread + product
  const [thread] = await db
    .select()
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);

  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  if (!product) throw new Error(`Product not found: ${productId}`);

  // Load agent (no tools needed for content generation)
  const agentConfig = loadAgentFromFile(
    join(process.cwd(), 'src/agents/content.md'),
    new Map(),
  );

  const context = createToolContext({});

  const userMessage = JSON.stringify({
    threadTitle: thread.title,
    threadBody: thread.body ?? '',
    subreddit: thread.subreddit,
    productName: product.name,
    productDescription: product.description,
    valueProp: product.valueProp,
    keywords: product.keywords,
  });

  const { result, usage } = await runAgent(
    agentConfig,
    userMessage,
    context,
    contentOutputSchema,
  );

  // Insert draft with status='pending' (requires human approval)
  await db.insert(drafts).values({
    userId,
    threadId,
    replyBody: result.replyBody,
    confidenceScore: result.confidence,
    whyItWorks: result.whyItWorks,
    ftcDisclosure: result.ftcDisclosure,
    status: 'pending',
  });

  // Log activity
  await db.insert(activityEvents).values({
    userId,
    eventType: 'draft_created',
    metadataJson: {
      threadId,
      subreddit: thread.subreddit,
      confidence: result.confidence,
      cost: usage.costUsd,
    },
  });

  // Publish SSE event
  await publishEvent(`shipflare:events:${userId}`, {
    type: 'draft_ready',
    threadTitle: thread.title,
    subreddit: thread.subreddit,
    confidence: result.confidence,
  });
}
