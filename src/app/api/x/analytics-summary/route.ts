import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { xAnalyticsSummary } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [summary] = await db
    .select()
    .from(xAnalyticsSummary)
    .where(eq(xAnalyticsSummary.userId, session.user.id))
    .orderBy(desc(xAnalyticsSummary.computedAt))
    .limit(1);

  if (!summary) {
    return NextResponse.json({ summary: null });
  }

  return NextResponse.json({
    summary: {
      periodStart: summary.periodStart,
      periodEnd: summary.periodEnd,
      bestContentTypes: summary.bestContentTypes,
      bestPostingHours: summary.bestPostingHours,
      audienceGrowthRate: summary.audienceGrowthRate,
      engagementRate: summary.engagementRate,
      totalImpressions: summary.totalImpressions,
      totalBookmarks: summary.totalBookmarks,
      computedAt: summary.computedAt,
    },
  });
}
