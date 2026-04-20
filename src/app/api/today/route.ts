import { NextResponse } from 'next/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { planItems } from '@/lib/db/schema';
import type { PlanItemState } from '@/lib/plan-state';

// V3 Today feed. Renders the user's pre-terminal plan_items
// (planned / drafted / ready_for_review / approved) as TodoItem-shaped
// rows so the existing <TodayContent /> UI keeps working without a full
// rewrite. Reply / discovery / engagement todos don't exist yet in v3 —
// every plan_item maps to a calendar/post-shaped card. That's okay: the
// discovery + reply-guy flows re-land on top of plan_items post-sprint.
//
// Response shape matches what `src/hooks/use-today.ts` expects, plus a
// top-level `hasAnyPlanItems` flag for the First Run empty state
// (frontend needs this to distinguish "genuinely no plan yet" from
// "plan exists, all items completed/skipped today").

const PENDING_STATES = [
  'planned',
  'drafted',
  'ready_for_review',
  'approved',
] as const satisfies readonly PlanItemState[];

function dayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

/**
 * Priority bucket the UI uses to color the card + sort the rail. We derive
 * it from `scheduledAt` relative to now:
 *   - already past → time_sensitive (overdue, user should act)
 *   - within today → time_sensitive
 *   - tomorrow+   → scheduled
 * The `optional` bucket isn't emitted yet — it's reserved for plan items
 * with userAction='auto' that the user can dismiss but isn't expected to
 * approve; we'll plumb that through when the auto-execute path ships.
 */
function derivePriority(
  scheduledAt: Date,
  now: Date,
): 'time_sensitive' | 'scheduled' | 'optional' {
  const { end } = dayBounds(now);
  if (scheduledAt.getTime() < end.getTime()) return 'time_sensitive';
  return 'scheduled';
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const now = new Date();
  const { start: todayStart, end: todayEnd } = dayBounds(now);
  const yStart = new Date(todayStart);
  yStart.setUTCDate(yStart.getUTCDate() - 1);

  // Pending items feed
  const pending = await db
    .select({
      id: planItems.id,
      kind: planItems.kind,
      state: planItems.state,
      channel: planItems.channel,
      scheduledAt: planItems.scheduledAt,
      title: planItems.title,
      description: planItems.description,
      createdAt: planItems.createdAt,
    })
    .from(planItems)
    .where(
      and(
        eq(planItems.userId, userId),
        inArray(planItems.state, PENDING_STATES),
      ),
    )
    .orderBy(planItems.scheduledAt);

  // Stats — single aggregate round-trip. Yesterday completions, today
  // completions+skips, and the raw pending count that the first-run
  // empty state keys off.
  const [stats] = await db
    .select({
      publishedYesterday: sql<number>`
        count(*) filter (
          where ${planItems.state} = 'completed'
            and ${planItems.completedAt} >= ${yStart}
            and ${planItems.completedAt} < ${todayStart}
        )
      `.mapWith(Number),
      actedToday: sql<number>`
        count(*) filter (
          where ${planItems.state} in ('completed', 'skipped')
            and ${planItems.completedAt} >= ${todayStart}
            and ${planItems.completedAt} < ${todayEnd}
        )
      `.mapWith(Number),
      pendingCount: sql<number>`
        count(*) filter (
          where ${planItems.state} in ('planned', 'drafted', 'ready_for_review', 'approved')
        )
      `.mapWith(Number),
      anyItems: sql<number>`count(*)`.mapWith(Number),
    })
    .from(planItems)
    .where(eq(planItems.userId, userId));

  const items = pending.map((row) => ({
    id: row.id,
    draftId: null,
    todoType: 'approve_post' as const,
    source: 'calendar' as const,
    priority: derivePriority(row.scheduledAt, now),
    status: 'pending' as const,
    title: row.title,
    platform: row.channel ?? 'x',
    community: null,
    externalUrl: null,
    confidence: null,
    scheduledFor: row.scheduledAt.toISOString(),
    // Keep the expiresAt contract that the UI reads as a deadline: we
    // reuse scheduledAt here until plan_items grows a real SLA column.
    expiresAt: row.scheduledAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    draftBody: null,
    draftConfidence: null,
    draftWhyItWorks: null,
    draftType: null,
    draftPostTitle: null,
    draftMedia: null,
    threadTitle: null,
    threadBody: null,
    threadAuthor: null,
    threadUrl: null,
    threadUpvotes: null,
    threadCommentCount: null,
    threadPostedAt: null,
    threadDiscoveredAt: null,
    calendarContentType: row.kind,
    calendarScheduledAt: row.scheduledAt.toISOString(),
  }));

  return NextResponse.json({
    items,
    hasAnyPlanItems: (stats?.anyItems ?? 0) > 0,
    stats: {
      published_yesterday: stats?.publishedYesterday ?? 0,
      pending_count: stats?.pendingCount ?? 0,
      acted_today: stats?.actedToday ?? 0,
    },
  });
}
