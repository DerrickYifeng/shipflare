import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { products, threads, drafts, activityEvents, todoItems, channels } from '@/lib/db/schema';
import { channelPosts } from '@/lib/db/schema/channels';
import { eq, and } from 'drizzle-orm';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { contentOutputSchema } from '@/agents/schemas';
import { publishUserEvent } from '@/lib/redis';
import { enqueueDream, enqueueReview } from '@/lib/queue';
import { join } from 'path';
import type { ContentJobData } from '@/lib/queue/types';
import { getTraceId } from '@/lib/queue/types';
import { createLogger, loggerForJob } from '@/lib/logger';
import { MemoryStore } from '@/memory/store';
import { AgentDream } from '@/memory/dream';
import { buildMemoryPrompt } from '@/memory/prompt-builder';
import { recordPipelineEvent } from '@/lib/pipeline-events';
import { pipelineEvents } from '@/lib/db/schema';
import { desc } from 'drizzle-orm';

const baseLog = createLogger('worker:content');

const SKILLS_DIR = join(process.cwd(), 'src', 'skills');

export async function processContent(job: Job<ContentJobData>) {
  const traceId = getTraceId(job.data, job.id);
  const log = loggerForJob(baseLog, job);
  const { userId, threadId, productId } = job.data;
  const draftType = (job.data as ContentJobData & { draftType?: string }).draftType ?? 'reply';
  const communityIntel = (job.data as ContentJobData & { communityIntel?: unknown }).communityIntel;

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

  log.info(`Generating ${draftType} draft for thread ${threadId} in r/${thread.community}`);

  // Load memory context
  const memoryStore = new MemoryStore(userId, productId);
  const dream = new AgentDream(memoryStore);
  const memoryPrompt = await buildMemoryPrompt(memoryStore);

  // Load recent channel posts for deduplication — most-recent-first, text only.
  // Replaces the old JSONB channels.post_history read; see 0016 / channelPosts.
  const postHistoryRows = await db
    .select({ text: channelPosts.text })
    .from(channelPosts)
    .innerJoin(channels, eq(channelPosts.channelId, channels.id))
    .where(and(eq(channels.userId, userId), eq(channels.platform, thread.platform ?? 'reddit')))
    .orderBy(desc(channelPosts.postedAt))
    .limit(20);

  const recentPostHistory = postHistoryRows.map((r) => r.text);

  // Run content-gen skill (single-item fan-out)
  const skill = loadSkill(join(SKILLS_DIR, 'content-gen'));
  const { results, usage } = await runSkill({
    skill,
    input: {
      threads: [
        {
          threadTitle: thread.title,
          threadBody: thread.body ?? '',
          subreddit: thread.community,
          productName: product.name,
          productDescription: product.description,
          valueProp: product.valueProp,
          keywords: product.keywords,
          lifecyclePhase: product.lifecyclePhase ?? 'pre_launch',
          draftType,
          communityIntel,
          ...(recentPostHistory.length > 0 ? { recentPostHistory } : {}),
        },
      ],
    },
    memoryPrompt: memoryPrompt || undefined,
    outputSchema: contentOutputSchema,
    runId: traceId,
  });

  const result = results[0];
  if (!result) throw new Error('Content skill returned no results');

  log.info(`Draft created: confidence=${result.confidence.toFixed(2)}, cost=$${usage.costUsd.toFixed(4)}`);

  // Insert draft — use .returning() to get the ID for review enqueue
  const [inserted] = await db
    .insert(drafts)
    .values({
      userId,
      threadId,
      draftType,
      postTitle: result.postTitle ?? null,
      replyBody: result.replyBody,
      confidenceScore: result.confidence,
      whyItWorks: result.whyItWorks,
      ftcDisclosure: result.ftcDisclosure,
      status: 'pending',
    })
    .returning({ id: drafts.id });

  // Enqueue review for the newly created draft
  if (inserted) {
    // Telemetry: stage='draft_created'. Duration is elapsed since the
    // 'discovered' event for the same thread if we can find one, else null.
    let durationMs: number | null = null;
    try {
      const [discoveredEvent] = await db
        .select({ enteredAt: pipelineEvents.enteredAt })
        .from(pipelineEvents)
        .where(eq(pipelineEvents.threadId, threadId))
        .orderBy(desc(pipelineEvents.enteredAt))
        .limit(1);
      if (discoveredEvent) {
        durationMs = Date.now() - discoveredEvent.enteredAt.getTime();
      }
    } catch {
      // non-fatal — leave durationMs null
    }
    await recordPipelineEvent({
      userId,
      productId,
      threadId,
      draftId: inserted.id,
      stage: 'draft_created',
      durationMs: durationMs ?? undefined,
      cost: usage.costUsd,
      metadata: { draftType, confidence: result.confidence },
    });

    await enqueueReview({ userId, draftId: inserted.id, productId, traceId });

    // For reply drafts, inject a todoItem directly so it appears in Today
    // immediately (without waiting for the next seed cycle)
    if (draftType === 'reply') {
      const now = new Date();
      const threadAgeHours = (now.getTime() - (thread.discoveredAt?.getTime() ?? now.getTime())) / (1000 * 60 * 60);
      const isTimeSensitive = threadAgeHours < 4 || (thread.upvotes ?? 0) > 50;

      await db
        .insert(todoItems)
        .values({
          userId,
          draftId: inserted.id,
          todoType: 'reply_thread',
          source: 'discovery',
          priority: isTimeSensitive ? 'time_sensitive' : 'scheduled',
          title: thread.title.length > 100
            ? thread.title.slice(0, 97) + '...'
            : thread.title,
          platform: thread.platform ?? 'reddit',
          community: thread.community,
          externalUrl: thread.url,
          confidence: result.confidence,
          expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000),
        })
        .onConflictDoNothing();

      await publishUserEvent(userId, 'drafts', {
        type: 'todo_added',
        todoType: 'reply_thread',
      });
    }
  }

  // Log activity
  await db.insert(activityEvents).values({
    userId,
    eventType: 'draft_created',
    metadataJson: {
      threadId,
      community: thread.community,
      confidence: result.confidence,
      draftType,
      cost: usage.costUsd,
    },
  });

  // Publish SSE event
  await publishUserEvent(userId, 'drafts', {
    type: 'draft_ready',
    threadTitle: thread.title,
    community: thread.community,
    confidence: result.confidence,
    draftType,
  });

  // --- Memory: log insights from this content run ---
  const confLabel = result.confidence >= 0.8 ? 'high' : result.confidence >= 0.5 ? 'medium' : 'low';
  await dream.logInsight(
    `Content draft (${draftType}) for r/${thread.community} "${thread.title}" — confidence ${result.confidence} (${confLabel}). Reason: ${result.whyItWorks}`,
  );

  // Check if distillation should be triggered
  if (await dream.shouldDistill()) {
    await enqueueDream({ productId });
  }
}
