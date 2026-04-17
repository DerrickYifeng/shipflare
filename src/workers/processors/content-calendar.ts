import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import {
  products,
  channels,
  drafts,
  threads,
  activityEvents,
  xContentCalendar,
  codeSnapshots,
} from '@/lib/db/schema';
import { eq, and, lte } from 'drizzle-orm';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { contentCreatorOutputSchema } from '@/agents/schemas';
import type { ContentCreatorOutput } from '@/agents/schemas';
import { enqueueReview, enqueueDream, enqueueContentCalendar } from '@/lib/queue';
import { publishEvent } from '@/lib/redis';
import { join } from 'path';
import type { ContentCalendarJobData } from '@/lib/queue/types';
import { isFanoutJob } from '@/lib/queue/types';
import { createLogger } from '@/lib/logger';
import { MemoryStore } from '@/memory/store';
import { AgentDream } from '@/memory/dream';
import { buildMemoryPrompt } from '@/memory/prompt-builder';

const log = createLogger('worker:x-content-calendar');

const contentBatchSkill = loadSkill(
  join(process.cwd(), 'src/skills/content-batch'),
);

async function processXContentCalendarForUser(
  userId: string,
  productId: string,
  processUpcoming = false,
) {
  log.info(`Processing X content calendar for user ${userId}`);

  // Load product
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!product) throw new Error(`Product not found: ${productId}`);

  // Find scheduled X items that are due (or upcoming within 48h when triggered manually)
  const now = new Date();
  const cutoff = processUpcoming
    ? new Date(now.getTime() + 48 * 60 * 60 * 1000)
    : now;
  const dueItems = await db
    .select()
    .from(xContentCalendar)
    .where(
      and(
        eq(xContentCalendar.userId, userId),
        eq(xContentCalendar.channel, 'x'),
        eq(xContentCalendar.status, 'scheduled'),
        lte(xContentCalendar.scheduledAt, cutoff),
      ),
    );

  if (dueItems.length === 0) {
    log.info('No content calendar items due, skipping');
    return;
  }

  log.info(`Found ${dueItems.length} due calendar items`);

  // Load channel post history for deduplication
  const [channel] = await db
    .select({ postHistory: channels.postHistory })
    .from(channels)
    .where(and(eq(channels.userId, userId), eq(channels.platform, 'x')))
    .limit(1);

  const recentPostHistory = (channel?.postHistory ?? [])
    .filter((p) => !!p?.text)
    .map((p) => p.text)
    .slice(0, 20);

  // Load code snapshot for recent changes context
  const [snapshot] = await db
    .select({ diffSummary: codeSnapshots.diffSummary, changesDetected: codeSnapshots.changesDetected })
    .from(codeSnapshots)
    .where(eq(codeSnapshots.productId, productId))
    .limit(1);

  const recentCodeChanges = snapshot?.changesDetected ? snapshot.diffSummary ?? undefined : undefined;

  // Build calendar items for the skill (strategy is auto-injected via skill references)
  const calendarItems = dueItems.map((item) => ({
    contentType: item.contentType,
    topic: item.topic ?? undefined,
    productName: product.name,
    productDescription: product.description,
    valueProp: product.valueProp ?? '',
    keywords: product.keywords,
    lifecyclePhase: product.lifecyclePhase ?? 'pre_launch',
    isThread: item.contentType === 'thread',
    ...(recentPostHistory.length > 0 ? { recentPostHistory } : {}),
    ...(recentCodeChanges ? { recentCodeChanges } : {}),
  }));

  // Load memory
  const memoryStore = new MemoryStore(productId);
  const dream = new AgentDream(memoryStore);
  const memoryPrompt = await buildMemoryPrompt(memoryStore);

  // Run content batch skill
  const result = await runSkill<ContentCreatorOutput>({
    skill: contentBatchSkill,
    input: { calendarItems },
    deps: {},
    memoryPrompt: memoryPrompt || undefined,
    outputSchema: contentCreatorOutputSchema,
  });

  let draftsCreated = 0;

  for (let i = 0; i < result.results.length; i++) {
    const content = result.results[i];
    const calendarItem = dueItems[i];

    // Combine tweets into single body (for threads, join with double newline)
    const replyBody = content.tweets.join('\n\n---\n\n');
    const isThread = content.tweets.length > 1;

    // Create a pseudo-thread record to plug into the existing draft pipeline.
    // onConflictDoNothing protects against retries re-processing the same
    // calendar item (unique on user_id, platform, external_id).
    const [threadRecord] = await db
      .insert(threads)
      .values({
        userId,
        externalId: `calendar-${calendarItem.id}`,
        platform: 'x',
        community: content.contentType,
        title: content.tweets[0].slice(0, 200),
        url: '',
        relevanceScore: content.confidence,
      })
      .onConflictDoNothing({
        target: [threads.userId, threads.platform, threads.externalId],
      })
      .returning();

    if (!threadRecord) continue;

    // Create draft with link reply metadata
    const draftData: Record<string, unknown> = {
      userId,
      threadId: threadRecord.id,
      draftType: isThread ? 'original_post' : 'original_post',
      postTitle: isThread ? 'Thread' : undefined,
      replyBody,
      confidenceScore: content.confidence,
      whyItWorks: content.whyItWorks,
    };

    const [draft] = await db
      .insert(drafts)
      .values(draftData as typeof drafts.$inferInsert)
      .returning();

    draftsCreated++;

    // Link draft to calendar item
    await db
      .update(xContentCalendar)
      .set({
        status: 'draft_created',
        draftId: draft.id,
        updatedAt: now,
      })
      .where(eq(xContentCalendar.id, calendarItem.id));

    // Auto-enqueue review
    await enqueueReview({
      userId,
      draftId: draft.id,
      productId,
    });
  }

  log.info(
    `Created ${draftsCreated} content drafts, cost $${result.usage.costUsd.toFixed(4)}`,
  );

  // Publish SSE event
  await publishEvent(`shipflare:events:${userId}`, {
    type: 'agent_complete',
    agentName: 'content-batch',
    stats: {
      calendarItemsProcessed: dueItems.length,
      draftsCreated,
    },
    cost: result.usage.costUsd,
  });

  // Log activity
  await db.insert(activityEvents).values({
    userId,
    eventType: 'x_content_calendar',
    metadataJson: {
      itemsProcessed: dueItems.length,
      draftsCreated,
      cost: result.usage.costUsd,
    },
  });

  // Memory
  const types = dueItems.map((i) => i.contentType).join(', ');
  await dream.logInsight(
    `Content calendar: processed ${dueItems.length} items (${types}), created ${draftsCreated} drafts`,
  );

  if (await dream.shouldDistill()) {
    await enqueueDream({ productId });
  }
}

export async function processXContentCalendar(
  job: Job<ContentCalendarJobData>,
) {
  // Cron fan-out: enqueue per-user jobs so the content-calendar worker's
  // concurrency:2 actually splits work across users. Accepts both the new
  // discriminated-union payload and the legacy `userId === '__all__'` sentinel.
  if (isFanoutJob(job.data)) {
    const platform =
      (job.data as { platform?: string }).platform ?? 'x';
    const xChannels = await db
      .select({ userId: channels.userId })
      .from(channels)
      .where(eq(channels.platform, platform));

    const userIds = [...new Set(xChannels.map((c) => c.userId))];
    log.info(
      `Cron fan-out: enqueueing ${userIds.length} per-user content-calendar jobs (${platform})`,
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

      await enqueueContentCalendar({
        userId: uid,
        productId: userProduct.id,
        platform,
      });
      enqueued++;
    }
    log.info(`Cron fan-out enqueued ${enqueued} content-calendar jobs`);
    return;
  }

  const data = job.data as Extract<ContentCalendarJobData, { userId: string }>;
  const { userId, productId, processUpcoming } = data;
  await processXContentCalendarForUser(userId, productId, processUpcoming);
}
