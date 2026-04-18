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
  weeklyThemes,
} from '@/lib/db/schema';
import { channelPosts } from '@/lib/db/schema/channels';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { slotBodyOutputSchema, type SlotBodyOutput } from '@/agents/schemas';
import {
  runContentValidators,
  buildRepairPrompt,
  summarizeFailures,
  type ContentValidatorFailure,
} from '@/lib/content/validators';
import { enqueueReview } from '@/lib/queue';
import { publishUserEvent } from '@/lib/redis';
import { MemoryStore } from '@/memory/store';
import { buildMemoryPrompt } from '@/memory/prompt-builder';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { CalendarSlotDraftJobData } from '@/lib/queue/types';
import { getTraceId } from '@/lib/queue/types';
import { recordPipelineEvent } from '@/lib/pipeline-events';
import { loadVoiceBlockForUser } from '@/lib/voice/inject';

const baseLog = createLogger('worker:calendar-slot-draft');
const slotBodySkill = loadSkill(join(process.cwd(), 'src/skills/slot-body'));

const MAX_REGEN_ATTEMPTS = 2;

type SlotBodySkillInput = Record<string, unknown> & {
  platform: string;
  contentType: string;
  angle: string;
  topic: string;
  thesis: string;
  thesisSource: string;
  pillar?: string;
  product: {
    name: string;
    description: string;
    valueProp: string;
    keywords: string[];
    lifecyclePhase: string;
  };
  recentPostHistory: string[];
  priorAnglesThisWeek: Array<{ angle: string; topic: string; body: string }>;
  voiceBlock: string | null;
  isThread: boolean;
  repairPrompt?: string;
};

/**
 * Validate each tweet in the slot-body output as a standalone post. Returns
 * the first tweet that fails (so the repair prompt can target it) along with
 * the aggregated failure list.
 */
function validateSlotBody(
  body: SlotBodyOutput,
  platform: string,
): { ok: boolean; failures: ContentValidatorFailure[] } {
  const allFailures: ContentValidatorFailure[] = [];
  for (const tweet of body.tweets) {
    const res = runContentValidators({ text: tweet, platform, kind: 'post' });
    if (!res.ok) allFailures.push(...res.failures);
  }
  return { ok: allFailures.length === 0, failures: allFailures };
}

/**
 * Process one planner-emitted calendar slot. Generates the body (single tweet
 * or thread) via the `slot-body` skill, writes a draft + thread row, and emits
 * per-slot SSE lifecycle events.
 *
 * Idempotent on `state === 'ready'`: a retry or duplicate enqueue for an
 * already-hydrated slot is a no-op. `state` transitions:
 *   queued -> drafting -> (ready | failed)
 *
 * Content-validator integration: drafts that fail the shared validator
 * pipeline (length, platform-leak, hallucinated-stats) trigger up to two
 * regeneration attempts. If the final attempt still fails, the draft is
 * still persisted but marked `needs_revision` with the validator failures
 * stored on `drafts.reviewJson` so the approval UI can surface them. The
 * calendar slot state still moves to `ready` — we never auto-discard
 * content, only flag it for human review.
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
  if (item.isWhiteSpace) {
    log.info(`slot ${calendarItemId} is white-space; no draft needed`);
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

  const [theme] = await db
    .select()
    .from(weeklyThemes)
    .where(eq(weeklyThemes.id, item.themeId!))
    .limit(1);
  if (!theme) throw new Error(`theme ${item.themeId} gone`);

  const priorAnglesRows = await db
    .select({
      angle: xContentCalendar.angle,
      topic: xContentCalendar.topic,
      replyBody: drafts.replyBody,
    })
    .from(xContentCalendar)
    .leftJoin(drafts, eq(drafts.id, xContentCalendar.draftId))
    .where(
      and(
        eq(xContentCalendar.themeId, theme.id),
        eq(xContentCalendar.state, 'ready'),
      ),
    );

  const priorAnglesThisWeek = priorAnglesRows
    .filter((r) => r.angle && r.topic && r.replyBody)
    .map((r) => ({
      angle: r.angle!,
      topic: r.topic!,
      body: r.replyBody!,
    }));

  const memoryStore = new MemoryStore(userId, productId);
  const memoryPrompt = await buildMemoryPrompt(memoryStore);
  const voiceBlock = await loadVoiceBlockForUser(userId, channel);

  const baseInput: SlotBodySkillInput = {
    platform: channel,
    contentType: item.contentType,
    angle: item.angle ?? 'claim',
    topic: item.topic ?? '',
    thesis: theme.thesis,
    thesisSource: theme.thesisSource,
    pillar: theme.pillar ?? undefined,
    product: {
      name: product.name,
      description: product.description,
      valueProp: product.valueProp ?? '',
      keywords: product.keywords,
      lifecyclePhase: product.lifecyclePhase ?? 'pre_launch',
    },
    recentPostHistory: postHistoryRows.map((r) => r.text),
    priorAnglesThisWeek,
    voiceBlock,
    isThread: item.contentType === 'thread',
  };

  let res = await runSkill<SlotBodyOutput>({
    skill: slotBodySkill,
    input: baseInput,
    deps: {},
    memoryPrompt: memoryPrompt || undefined,
    outputSchema: slotBodyOutputSchema,
    runId: traceId,
  });

  let body = res.results[0];
  let lastFailures: ContentValidatorFailure[] = [];

  for (let attempt = 0; attempt <= MAX_REGEN_ATTEMPTS; attempt += 1) {
    if (res.errors.length > 0 || !body?.tweets?.length) break;

    const validation = validateSlotBody(body, channel);
    if (validation.ok) {
      lastFailures = [];
      break;
    }

    lastFailures = validation.failures;
    log.warn(
      `slot-body content validators failed (attempt ${attempt + 1}/${MAX_REGEN_ATTEMPTS + 1}): ` +
        summarizeFailures(validation.failures),
      { calendarItemId },
    );

    if (attempt === MAX_REGEN_ATTEMPTS) break;

    const repairPrompt = buildRepairPrompt(validation.failures, channel);
    res = await runSkill<SlotBodyOutput>({
      skill: slotBodySkill,
      input: { ...baseInput, repairPrompt },
      deps: {},
      memoryPrompt: memoryPrompt || undefined,
      outputSchema: slotBodyOutputSchema,
      runId: traceId,
    });
    body = res.results[0];
  }

  if (res.errors.length > 0 || !body?.tweets?.length) {
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

  const replyBody = body.tweets.join('\n\n---\n\n');
  const isThread = body.tweets.length > 1;
  const needsReview = lastFailures.length > 0;

  if (needsReview) {
    log.info(
      `slot ${calendarItemId} needs review after ${MAX_REGEN_ATTEMPTS} regen attempt(s): ` +
        summarizeFailures(lastFailures),
    );
  }

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
      ...(needsReview
        ? {
            status: 'needs_revision' as const,
            reviewVerdict: 'REVISE',
            reviewJson: {
              source: 'content-validator',
              summary: summarizeFailures(lastFailures),
              failures: lastFailures,
            },
          }
        : {}),
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
    data: {
      draftId: draft.id,
      previewBody: replyBody.slice(0, 120),
      ...(needsReview ? { needsReview: true } : {}),
    },
  });
  await recordPipelineEvent({
    userId,
    productId,
    threadId: threadRecord.id,
    draftId: draft.id,
    // Always use `slot_ready`; the `needsReview` flag in metadata lets
    // funnel consumers distinguish auto-ready from human-review drafts
    // without widening the PipelineStage union.
    stage: 'slot_ready',
    cost: res.usage.costUsd,
    metadata: {
      calendarItemId,
      ...(needsReview
        ? {
            needsReview: true,
            contentValidatorFailures: summarizeFailures(lastFailures),
          }
        : {}),
    },
  });

  await enqueueReview({ userId, draftId: draft.id, productId, traceId });
}
