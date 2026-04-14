import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { activityEvents, drafts } from '@/lib/db/schema';
import { eq, and, gte, inArray, sql, desc } from 'drizzle-orm';

interface PipelineInfo {
  name: string;
  eventPrefix: string;
  cronDescription: string;
  cronIntervalMs: number;
}

const PIPELINES: PipelineInfo[] = [
  {
    name: 'Monitor',
    eventPrefix: 'x_monitor',
    cronDescription: 'Every 15 minutes',
    cronIntervalMs: 15 * 60 * 1000,
  },
  {
    name: 'Calendar',
    eventPrefix: 'x_content_calendar',
    cronDescription: 'Every hour',
    cronIntervalMs: 60 * 60 * 1000,
  },
  {
    name: 'Metrics',
    eventPrefix: 'x_metrics',
    cronDescription: 'Every 6 hours',
    cronIntervalMs: 6 * 60 * 60 * 1000,
  },
  {
    name: 'Analytics',
    eventPrefix: 'x_analytics',
    cronDescription: 'Daily at 5am UTC',
    cronIntervalMs: 24 * 60 * 60 * 1000,
  },
];

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Get last activity events for each pipeline (last 24h)
  const recentEvents = await db
    .select({
      eventType: activityEvents.eventType,
      createdAt: activityEvents.createdAt,
    })
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.userId, userId),
        gte(activityEvents.createdAt, oneDayAgo),
      ),
    )
    .orderBy(desc(activityEvents.createdAt));

  // Draft counts
  const [draftCounts] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${drafts.status} = 'pending')`,
      approved: sql<number>`count(*) filter (where ${drafts.status} = 'approved')`,
      posted: sql<number>`count(*) filter (where ${drafts.status} = 'posted')`,
    })
    .from(drafts)
    .where(eq(drafts.userId, userId));

  // Build pipeline status
  const pipelineStatus = PIPELINES.map((pipeline) => {
    const matchingEvents = recentEvents.filter(
      (e) => e.eventType.startsWith(pipeline.eventPrefix),
    );
    const lastRun = matchingEvents[0]?.createdAt ?? null;
    const errorCount = matchingEvents.filter(
      (e) => e.eventType.includes('error') || e.eventType.includes('failed'),
    ).length;

    // Estimate next run from last run + interval
    let nextRun: Date | null = null;
    if (lastRun) {
      nextRun = new Date(lastRun.getTime() + pipeline.cronIntervalMs);
      if (nextRun.getTime() < Date.now()) {
        nextRun = new Date(Date.now() + pipeline.cronIntervalMs);
      }
    }

    let status: 'healthy' | 'warning' | 'error' = 'healthy';
    if (errorCount > 3) status = 'error';
    else if (errorCount > 0) status = 'warning';
    else if (!lastRun) status = 'warning';

    return {
      name: pipeline.name,
      status,
      lastRun: lastRun?.toISOString() ?? null,
      nextRun: nextRun?.toISOString() ?? null,
      cronDescription: pipeline.cronDescription,
      errorCount,
    };
  });

  return NextResponse.json({
    pipelines: pipelineStatus,
    drafts: {
      pending: Number(draftCounts?.pending ?? 0),
      approved: Number(draftCounts?.approved ?? 0),
      posted: Number(draftCounts?.posted ?? 0),
    },
  });
}
