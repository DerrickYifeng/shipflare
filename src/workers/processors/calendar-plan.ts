import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import {
  xContentCalendar,
  xFollowerSnapshots,
  xTweetMetrics,
  xAnalyticsSummary,
  products,
  userPreferences,
  activityEvents,
} from '@/lib/db/schema';
import { eq, desc, and, gte, inArray } from 'drizzle-orm';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import {
  calendarPlanOutputSchema,
  type CalendarPlanOutput,
} from '@/agents/schemas';
import {
  enqueueCalendarSlotDraft,
  todoSeedQueue,
} from '@/lib/queue';
import { publishUserEvent } from '@/lib/redis';
import { recordPipelineEvent } from '@/lib/pipeline-events';
import { MemoryStore } from '@/memory/store';
import { buildMemoryPrompt } from '@/memory/prompt-builder';
import { createLogger, loggerForJob } from '@/lib/logger';
import { join } from 'path';
import type { CalendarPlanJobData } from '@/lib/queue/types';
import { getTraceId } from '@/lib/queue/types';

const baseLog = createLogger('worker:calendar-plan');

const plannerSkill = loadSkill(
  join(process.cwd(), 'src/skills/calendar-planner'),
);

export async function processCalendarPlan(job: Job<CalendarPlanJobData>) {
  const traceId = getTraceId(job.data, job.id);
  const log = loggerForJob(baseLog, job);
  const { userId, productId, channel, startDate: startDateStr } = job.data;

  log.info(`Planning calendar for channel=${channel}`);

  // Load product
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!product) throw new Error(`Product not found: ${productId}`);

  // Get latest follower count
  const [latestSnapshot] = await db
    .select()
    .from(xFollowerSnapshots)
    .where(eq(xFollowerSnapshots.userId, userId))
    .orderBy(desc(xFollowerSnapshots.snapshotAt))
    .limit(1);

  // Get recent tweet performance (top 10 by bookmarks)
  const recentMetrics = await db
    .select({
      tweetId: xTweetMetrics.tweetId,
      impressions: xTweetMetrics.impressions,
      bookmarks: xTweetMetrics.bookmarks,
      likes: xTweetMetrics.likes,
      replies: xTweetMetrics.replies,
      retweets: xTweetMetrics.retweets,
    })
    .from(xTweetMetrics)
    .where(eq(xTweetMetrics.userId, userId))
    .orderBy(desc(xTweetMetrics.bookmarks))
    .limit(10);

  // Get latest analytics summary
  const [analyticsSummary] = await db
    .select()
    .from(xAnalyticsSummary)
    .where(eq(xAnalyticsSummary.userId, userId))
    .orderBy(desc(xAnalyticsSummary.computedAt))
    .limit(1);

  // Get user preferences for posting hours and content mix
  const [prefs] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  // Build memory context
  const memoryStore = new MemoryStore(userId, productId);
  const memoryPrompt = await buildMemoryPrompt(memoryStore);

  const startDate = new Date(startDateStr);
  const postingHours = (prefs?.postingHoursUtc as number[]) ?? [14, 17, 21];

  // Run planner skill
  log.info(
    `Running calendar planner, followerCount=${latestSnapshot?.followerCount ?? 0}`,
  );

  const result = await runSkill<CalendarPlanOutput>({
    skill: plannerSkill,
    input: {
      channel,
      productName: product.name,
      productDescription: product.description,
      valueProp: product.valueProp ?? '',
      keywords: product.keywords,
      lifecyclePhase: product.lifecyclePhase ?? 'pre_launch',
      followerCount: latestSnapshot?.followerCount ?? 0,
      topPerformingContent: recentMetrics,
      startDate: startDate.toISOString(),
      postingHours,
      contentMix: prefs
        ? {
            metric: prefs.contentMixMetric,
            educational: prefs.contentMixEducational,
            engagement: prefs.contentMixEngagement,
            product: prefs.contentMixProduct,
          }
        : undefined,
      ...(analyticsSummary
        ? {
            analyticsInsights: {
              bestContentTypes: analyticsSummary.bestContentTypes,
              bestPostingHours: analyticsSummary.bestPostingHours,
              audienceGrowthRate: analyticsSummary.audienceGrowthRate,
              engagementRate: analyticsSummary.engagementRate,
            },
          }
        : {}),
    },
    deps: {},
    memoryPrompt: memoryPrompt || undefined,
    outputSchema: calendarPlanOutputSchema,
    runId: traceId,
  });

  if (result.errors.length > 0) {
    const errorMsg = result.errors.map((e) => e.error).join(', ');
    log.error(`Planner failed: ${errorMsg}`);
    await publishUserEvent(userId, 'agents', {
      type: 'calendar_plan_failed',
      error: 'Calendar planning failed. Please try again.',
    });
    throw new Error(`Calendar planner failed: ${errorMsg}`);
  }

  const plan = result.results[0];
  if (!plan || plan.entries.length === 0) {
    log.error('Planner returned empty calendar');
    await publishUserEvent(userId, 'agents', {
      type: 'calendar_plan_failed',
      error: 'Planner returned empty calendar.',
    });
    throw new Error('Planner returned empty calendar');
  }

  // Map planner entries to calendar records. Seed `state: 'queued'` explicitly
  // so the downstream slot-body fan-out has an unambiguous starting state
  // even if the DB default shifts.
  const entries = plan.entries.map((entry) => {
    const scheduledAt = new Date(startDate);
    scheduledAt.setDate(scheduledAt.getDate() + entry.dayOffset);
    scheduledAt.setHours(entry.hour, 0, 0, 0);

    return {
      userId,
      productId,
      channel,
      scheduledAt,
      contentType: entry.contentType,
      topic: entry.topic,
      state: 'queued' as const,
    };
  });

  // Clear pre-existing future shells in the plan pipeline to prevent duplicates
  // on re-generate. Only in-flight shell states are safe to drop — ready /
  // approved / posted items must be preserved.
  const deleted = await db
    .delete(xContentCalendar)
    .where(
      and(
        eq(xContentCalendar.userId, userId),
        inArray(xContentCalendar.state, ['queued', 'drafting', 'failed']),
        gte(xContentCalendar.scheduledAt, new Date()),
      ),
    )
    .returning({ id: xContentCalendar.id });

  if (deleted.length > 0) {
    log.info(`Cleared ${deleted.length} old scheduled calendar items`);
  }

  const created = await db
    .insert(xContentCalendar)
    .values(entries)
    .returning();

  log.info(
    `Generated ${created.length} strategic calendar entries (phase ${plan.phase}, channel: ${channel}), cost $${result.usage.costUsd.toFixed(4)}`,
  );

  // Emit per-slot `queued` events so the UI can render the skeleton grid
  // immediately, then a single `plan_shell_ready` envelope for page-level
  // strategy copy. Reply-target scanning is decoupled — see discovery-scan.
  for (const row of created) {
    await publishUserEvent(userId, 'agents', {
      type: 'pipeline',
      pipeline: 'plan',
      itemId: row.id,
      state: 'queued',
      data: {
        scheduledAt: row.scheduledAt.toISOString(),
        contentType: row.contentType,
        topic: row.topic,
      },
    });
  }
  await publishUserEvent(userId, 'agents', {
    type: 'plan_shell_ready',
    calendarItemIds: created.map((r) => r.id),
    phase: plan.phase,
    weeklyStrategy: plan.weeklyStrategy,
  });
  await recordPipelineEvent({
    userId,
    productId,
    stage: 'plan_shell_ready',
    cost: result.usage.costUsd,
    metadata: { itemCount: created.length },
  });

  // Pipeline: per-slot fan-out only. Reply search is decoupled — see discovery-scan.
  for (const row of created) {
    await enqueueCalendarSlotDraft({
      schemaVersion: 1,
      traceId,
      userId,
      productId,
      calendarItemId: row.id,
      channel,
    });
  }

  // Seed Today shortly after; matches existing delay.
  const ts = Date.now();
  await todoSeedQueue.add('seed', { userId }, {
    delay: 120_000,
    jobId: `generate-week-seed-${userId}-${ts}`,
  });

  log.info(`Fanned out ${created.length} calendar-slot-draft jobs + todo-seed`);

  // Log activity
  await db.insert(activityEvents).values({
    userId,
    eventType: 'calendar_plan',
    metadataJson: {
      channel,
      phase: plan.phase,
      entriesCreated: created.length,
      cost: result.usage.costUsd,
    },
  });
}
