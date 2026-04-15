import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  xContentCalendar,
  xFollowerSnapshots,
  xTweetMetrics,
  xAnalyticsSummary,
  products,
  userPreferences,
  channels,
} from '@/lib/db/schema';
import { eq, desc, and, gte } from 'drizzle-orm';
import {
  enqueueContentCalendar,
  enqueueMonitor,
  enqueueDiscovery,
  todoSeedQueue,
} from '@/lib/queue';
import { PLATFORMS, isPlatformAvailable } from '@/lib/platform-config';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import {
  calendarPlanOutputSchema,
  type CalendarPlanOutput,
} from '@/agents/schemas';
import { MemoryStore } from '@/memory/store';
import { buildMemoryPrompt } from '@/memory/prompt-builder';
import { createLogger } from '@/lib/logger';
import { join } from 'path';

const log = createLogger('api:calendar:generate');

const plannerSkill = loadSkill(
  join(process.cwd(), 'src/skills/calendar-planner'),
);

/**
 * POST /api/calendar/generate
 * Generate a strategic weekly content calendar using the planner agent.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { channel?: string; startDate?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const channel = body.channel ?? 'x';

  // Load product
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.userId, session.user.id))
    .limit(1);

  if (!product) {
    return NextResponse.json(
      { error: 'No product configured. Complete onboarding first.' },
      { status: 400 },
    );
  }

  // Get latest follower count
  const [latestSnapshot] = await db
    .select()
    .from(xFollowerSnapshots)
    .where(eq(xFollowerSnapshots.userId, session.user.id))
    .orderBy(desc(xFollowerSnapshots.snapshotAt))
    .limit(1);

  // Get recent tweet performance (top 10 by bookmarks in last 30 days)
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
    .where(eq(xTweetMetrics.userId, session.user.id))
    .orderBy(desc(xTweetMetrics.bookmarks))
    .limit(10);

  // Get latest analytics summary (computed daily by analytics worker)
  const [analyticsSummary] = await db
    .select()
    .from(xAnalyticsSummary)
    .where(eq(xAnalyticsSummary.userId, session.user.id))
    .orderBy(desc(xAnalyticsSummary.computedAt))
    .limit(1);

  // Get user preferences for posting hours and content mix
  const [prefs] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, session.user.id))
    .limit(1);

  // Build memory context
  const memoryStore = new MemoryStore(product.id);
  const memoryPrompt = await buildMemoryPrompt(memoryStore);

  const startDate = body.startDate ? new Date(body.startDate) : new Date();
  startDate.setMinutes(0, 0, 0);
  startDate.setHours(startDate.getHours() + 1);

  // Run planner skill
  log.info(`Running calendar planner for channel=${channel}, followerCount=${latestSnapshot?.followerCount ?? 0}`);

  // Use configured posting hours, falling back to defaults
  const postingHours = (prefs?.postingHoursUtc as number[]) ?? [14, 17, 21];

  const result = await runSkill<CalendarPlanOutput>({
    skill: plannerSkill,
    input: {
      channel,
      productName: product.name,
      productDescription: product.description,
      valueProp: product.valueProp ?? '',
      keywords: product.keywords,
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
  });

  if (result.errors.length > 0) {
    log.error(`Planner failed: ${result.errors.map((e) => e.error).join(', ')}`);
    return NextResponse.json(
      { error: 'Calendar planning failed. Please try again.' },
      { status: 500 },
    );
  }

  const plan = result.results[0];
  if (!plan || plan.entries.length === 0) {
    return NextResponse.json(
      { error: 'Planner returned empty calendar.' },
      { status: 500 },
    );
  }

  // Map planner entries to calendar records
  const userId = session.user!.id!;
  const entries = plan.entries.map((entry) => {
    const scheduledAt = new Date(startDate);
    scheduledAt.setDate(scheduledAt.getDate() + entry.dayOffset);
    scheduledAt.setHours(entry.hour, 0, 0, 0);

    return {
      userId,
      productId: product.id,
      channel,
      scheduledAt,
      contentType: entry.contentType,
      topic: entry.topic,
    };
  });

  // Clear future scheduled-only items to prevent duplicates on re-generate
  // Keep items with draft_created/approved/posted status (already in progress)
  const deleted = await db
    .delete(xContentCalendar)
    .where(
      and(
        eq(xContentCalendar.userId, userId),
        eq(xContentCalendar.status, 'scheduled'),
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

  // --- Pipeline: enqueue downstream jobs to populate Today ---

  // 1. Content-calendar: generate drafts for items within next 48h
  await enqueueContentCalendar({
    userId,
    productId: product.id,
    platform: channel,
    processUpcoming: true,
  });

  // 2. Monitor: find reply targets from target accounts
  await enqueueMonitor({
    userId,
    productId: product.id,
    platform: channel,
  });

  // 3. Discovery: find threads to reply to across connected platforms
  const userChannels = await db
    .select({ platform: channels.platform })
    .from(channels)
    .where(eq(channels.userId, userId));

  const connectedPlatforms = new Set(userChannels.map((c) => c.platform));

  for (const [platformId, config] of Object.entries(PLATFORMS)) {
    if (!connectedPlatforms.has(platformId) || !isPlatformAvailable(platformId)) continue;
    await enqueueDiscovery({
      userId,
      productId: product.id,
      sources: config.defaultSources,
      platform: platformId,
    });
  }

  // 4. Todo seeds: 2-min for calendar posts, 5-min backup for discovery replies
  const ts = Date.now();
  await todoSeedQueue.add('seed', { userId }, {
    delay: 120_000,
    jobId: `generate-week-seed-${userId}-${ts}`,
  });
  await todoSeedQueue.add('seed', { userId }, {
    delay: 300_000,
    jobId: `generate-week-seed-late-${userId}-${ts}`,
  });

  log.info(`Pipeline enqueued: content-calendar, monitor, discovery, todo-seed for user ${userId}`);

  return NextResponse.json({
    phase: plan.phase,
    phaseDescription: plan.phaseDescription,
    weeklyStrategy: plan.weeklyStrategy,
    generated: created.length,
    items: created,
    cost: result.usage.costUsd,
    pipeline: {
      contentCalendar: 'queued',
      monitor: 'queued',
      discovery: connectedPlatforms.has('reddit') || connectedPlatforms.has('x') ? 'queued' : 'skipped',
      todoSeed: 'queued',
    },
  });
}
