import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { planItems, products } from '@/lib/db/schema';
import { weekBounds } from '@/lib/week-bounds';

/**
 * Briefing summary — aggregate plan_items shape consumed by the new
 * BriefingHeader component. Today / yesterday counts are bucketed by
 * `completedAt`; weekly totals are bucketed by `scheduledAt`. The
 * `isDay1` flag is true for the first 24h after the user finishes
 * onboarding so the UI can show a different welcome state.
 *
 * `nextDiscoveryAt` is intentionally `null` in v1 — the BriefingHeader
 * falls back to static copy when null. Computing the next discovery
 * tick belongs to a follow-up task (the queue / cron source of truth
 * lives elsewhere).
 */
export interface BriefingSummary {
  today: { awaiting: number; shipped: number; skipped: number };
  yesterday: { shipped: number; skipped: number };
  thisWeek: { totalQueued: number; totalShipped: number };
  isDay1: boolean;
  nextDiscoveryAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC midnight-to-midnight bounds for the day containing `now`. */
function dayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const now = new Date();
  const { start: todayStart, end: todayEnd } = dayBounds(now);
  const yStart = new Date(todayStart);
  yStart.setUTCDate(yStart.getUTCDate() - 1);
  const { weekStart, weekEnd } = weekBounds(now);

  // pg driver rejects raw Date in sql template binds — convert each
  // boundary to an ISO string before binding (Postgres parses ISO-8601
  // into timestamptz unambiguously).
  const yStartIso = yStart.toISOString();
  const todayStartIso = todayStart.toISOString();
  const todayEndIso = todayEnd.toISOString();
  const weekStartIso = weekStart.toISOString();
  const weekEndIso = weekEnd.toISOString();

  const [agg] = await db
    .select({
      todayAwaiting: sql<number>`
        count(*) filter (
          where ${planItems.state} in ('drafted', 'ready_for_review', 'approved')
        )
      `.mapWith(Number),
      todayShipped: sql<number>`
        count(*) filter (
          where ${planItems.state} = 'completed'
            and ${planItems.completedAt} >= ${todayStartIso}
            and ${planItems.completedAt} < ${todayEndIso}
        )
      `.mapWith(Number),
      todaySkipped: sql<number>`
        count(*) filter (
          where ${planItems.state} = 'skipped'
            and ${planItems.completedAt} >= ${todayStartIso}
            and ${planItems.completedAt} < ${todayEndIso}
        )
      `.mapWith(Number),
      yesterdayShipped: sql<number>`
        count(*) filter (
          where ${planItems.state} = 'completed'
            and ${planItems.completedAt} >= ${yStartIso}
            and ${planItems.completedAt} < ${todayStartIso}
        )
      `.mapWith(Number),
      yesterdaySkipped: sql<number>`
        count(*) filter (
          where ${planItems.state} = 'skipped'
            and ${planItems.completedAt} >= ${yStartIso}
            and ${planItems.completedAt} < ${todayStartIso}
        )
      `.mapWith(Number),
      weekQueued: sql<number>`
        count(*) filter (
          where ${planItems.state} in ('planned', 'drafted', 'ready_for_review', 'approved')
            and ${planItems.scheduledAt} >= ${weekStartIso}
            and ${planItems.scheduledAt} < ${weekEndIso}
        )
      `.mapWith(Number),
      weekShipped: sql<number>`
        count(*) filter (
          where ${planItems.state} = 'completed'
            and ${planItems.scheduledAt} >= ${weekStartIso}
            and ${planItems.scheduledAt} < ${weekEndIso}
        )
      `.mapWith(Number),
    })
    .from(planItems)
    .where(eq(planItems.userId, userId));

  const [productRow] = await db
    .select({ onboardingCompletedAt: products.onboardingCompletedAt })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  const onboardedAt = productRow?.onboardingCompletedAt ?? null;
  const isDay1 =
    onboardedAt !== null && Date.now() - onboardedAt.getTime() < DAY_MS;

  const summary: BriefingSummary = {
    today: {
      awaiting: agg?.todayAwaiting ?? 0,
      shipped: agg?.todayShipped ?? 0,
      skipped: agg?.todaySkipped ?? 0,
    },
    yesterday: {
      shipped: agg?.yesterdayShipped ?? 0,
      skipped: agg?.yesterdaySkipped ?? 0,
    },
    thisWeek: {
      totalQueued: agg?.weekQueued ?? 0,
      totalShipped: agg?.weekShipped ?? 0,
    },
    isDay1,
    nextDiscoveryAt: null,
  };

  return NextResponse.json(summary);
}
