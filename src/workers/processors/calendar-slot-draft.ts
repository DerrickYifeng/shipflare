import type { Job } from 'bullmq';
import { eq, and, desc } from 'drizzle-orm';
import { join } from 'path';
import { db } from '@/lib/db';
import {
  products,
  threads,
  drafts,
  xContentCalendar,
  channels,
} from '@/lib/db/schema';
import { channelPosts } from '@/lib/db/schema/channels';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { slotBodyOutputSchema, type SlotBodyOutput } from '@/agents/schemas';
import { enqueueReview } from '@/lib/queue';
import { publishUserEvent } from '@/lib/redis';
import { MemoryStore } from '@/memory/store';
import { buildMemoryPrompt } from '@/memory/prompt-builder';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { CalendarSlotDraftJobData } from '@/lib/queue/types';
import { getTraceId } from '@/lib/queue/types';
import { recordPipelineEvent } from '@/lib/pipeline-events';

const baseLog = createLogger('worker:calendar-slot-draft');
const slotBodySkill = loadSkill(join(process.cwd(), 'src/skills/slot-body'));

/**
 * Process one planner-emitted calendar slot. Generates the body (single tweet
 * or thread) via the `slot-body` skill, writes a draft + thread row, and emits
 * per-slot SSE lifecycle events.
 *
 * Idempotent on `state === 'ready'`: a retry or duplicate enqueue for an
 * already-hydrated slot is a no-op. `state` transitions:
 *   queued -> drafting -> (ready | failed)
 */
export async function processCalendarSlotDraft(
  job: Job<CalendarSlotDraftJobData>,
) {
  const traceId = getTraceId(job.data, job.id);
  const log = loggerForJob(baseLog, job);
  const { userId, productId, calendarItemId, channel } = job.data;

  const [item] = await db
    .select()
    .from(xContentCalendar)
    .where(eq(xContentCalendar.id, calendarItemId))
    .limit(1);
  if (!item) {
    log.warn(`calendarItem ${calendarItemId} not found; discarding`);
    return;
  }
  if (item.state === 'ready' && item.draftId) {
    log.info(`slot ${calendarItemId} already ready; skipping`);
    return;
  }

  await db
    .update(xContentCalendar)
    .set({ state: 'drafting', lastAttemptAt: new Date() })
    .where(eq(xContentCalendar.id, calendarItemId));
  await publishUserEvent(userId, 'agents', {
    type: 'pipeline',
    pipeline: 'plan',
    itemId: calendarItemId,
    state: 'drafting',
  });

  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!product) throw new Error(`product ${productId} gone`);

  // Explicit projection on channels join — never leak OAuth tokens.
  const postHistoryRows = await db
    .select({ text: channelPosts.text })
    .from(channelPosts)
    .innerJoin(channels, eq(channelPosts.channelId, channels.id))
    .where(and(eq(channels.userId, userId), eq(channels.platform, channel)))
    .orderBy(desc(channelPosts.postedAt))
    .limit(20);

  const memoryStore = new MemoryStore(userId, productId);
  const memoryPrompt = await buildMemoryPrompt(memoryStore);

  const res = await runSkill<SlotBodyOutput>({
    skill: slotBodySkill,
    input: {
      contentType: item.contentType,
      topic: item.topic ?? '',
      product: {
        name: product.name,
        description: product.description,
        valueProp: product.valueProp ?? '',
        keywords: product.keywords,
        lifecyclePhase: product.lifecyclePhase ?? 'pre_launch',
      },
      recentPostHistory: postHistoryRows.map((r) => r.text),
      isThread: item.contentType === 'thread',
    },
    deps: {},
    memoryPrompt: memoryPrompt || undefined,
    outputSchema: slotBodyOutputSchema,
    runId: traceId,
  });

  if (res.errors.length > 0 || !res.results[0]?.tweets?.length) {
    const reason = res.errors[0]?.error ?? 'empty output';
    await db
      .update(xContentCalendar)
      .set({ state: 'failed', failureReason: reason })
      .where(eq(xContentCalendar.id, calendarItemId));
    await publishUserEvent(userId, 'agents', {
      type: 'pipeline',
      pipeline: 'plan',
      itemId: calendarItemId,
      state: 'failed',
      data: { reason },
    });
    await recordPipelineEvent({
      userId,
      productId,
      stage: 'slot_failed',
      metadata: { calendarItemId },
    });
    return;
  }

  const body = res.results[0];
  const replyBody = body.tweets.join('\n\n---\n\n');
  const isThread = body.tweets.length > 1;

  const [threadRecord] = await db
    .insert(threads)
    .values({
      userId,
      externalId: `calendar-${calendarItemId}`,
      platform: channel,
      community: item.contentType,
      title: body.tweets[0].slice(0, 200),
      url: '',
      relevanceScore: body.confidence,
    })
    .onConflictDoNothing({
      target: [threads.userId, threads.platform, threads.externalId],
    })
    .returning();

  if (!threadRecord) {
    log.warn(`thread conflict for calendar-${calendarItemId}; skipping`);
    return;
  }

  const [draft] = await db
    .insert(drafts)
    .values({
      userId,
      threadId: threadRecord.id,
      draftType: 'original_post',
      postTitle: isThread ? 'Thread' : undefined,
      replyBody,
      confidenceScore: body.confidence,
      whyItWorks: body.whyItWorks,
    })
    .returning();

  await db
    .update(xContentCalendar)
    .set({ state: 'ready', draftId: draft.id, status: 'draft_created' })
    .where(eq(xContentCalendar.id, calendarItemId));

  await publishUserEvent(userId, 'agents', {
    type: 'pipeline',
    pipeline: 'plan',
    itemId: calendarItemId,
    state: 'ready',
    data: { draftId: draft.id, previewBody: replyBody.slice(0, 120) },
  });
  await recordPipelineEvent({
    userId,
    productId,
    threadId: threadRecord.id,
    draftId: draft.id,
    stage: 'slot_ready',
    cost: res.usage.costUsd,
    metadata: { calendarItemId },
  });

  await enqueueReview({ userId, draftId: draft.id, productId, traceId });
}
