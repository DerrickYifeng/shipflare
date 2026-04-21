import { NextResponse, type NextRequest } from 'next/server';
import { and, eq, gte, lt, ne } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { planItems } from '@/lib/db/schema';
import type { PlanItemState } from '@/lib/plan-state';

// Calendar view: 7-day window over `plan_items`, grouped by day.
//
// Read-only. Scoped to `userId = session.user.id`. Excludes `superseded`
// and `stale` items at SQL level so the grid never renders ghosts from
// a previous replan.

export const dynamic = 'force-dynamic';

// Kinds that we leave off the calendar because rendering helps nothing —
// the user does metric jobs via /today status, not the calendar. Everything
// else the Tactical Planner schedules shows up. Kept as an `as const` so
// the compiler catches new kinds that need a routing decision.
type CalendarKind =
  | 'content_post'
  | 'content_reply'
  | 'email_send'
  | 'interview'
  | 'setup_task'
  | 'launch_asset'
  | 'runsheet_beat'
  | 'metrics_compute'
  | 'analytics_summary';

// superseded + stale items survive in the DB for audit but must never
// appear on the calendar — they're ghost rows from a previous replan.

interface CalendarItemDTO {
  id: string;
  kind: CalendarKind;
  state: PlanItemState;
  channel: string | null;
  scheduledAt: string;
  title: string;
  description: string | null;
  phase: string;
}

interface CalendarDay {
  date: string; // YYYY-MM-DD (UTC)
  items: CalendarItemDTO[];
}

interface CalendarResponse {
  weekStart: string;
  weekEnd: string; // exclusive
  prev: string;
  next: string;
  days: CalendarDay[];
  totals: {
    scheduled: number;
    completed: number;
    skipped: number;
  };
}

const MS_PER_DAY = 86_400_000;

/**
 * Monday 00:00 UTC of the week containing `d`. Matches the week boundary
 * the tactical planner uses (see `src/app/api/onboarding/plan/route.ts`
 * weekBounds helper) so the calendar week lines up with the plan.
 */
function mondayUtc(d: Date): Date {
  const w = new Date(d);
  w.setUTCHours(0, 0, 0, 0);
  const day = w.getUTCDay(); // 0 = Sun
  const diff = (day + 6) % 7; // days since Monday
  w.setUTCDate(w.getUTCDate() - diff);
  return w;
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseWeekStart(raw: string | null): Date {
  if (!raw) return mondayUtc(new Date());
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return mondayUtc(new Date());
  return mondayUtc(new Date(ms));
}

export async function GET(request: NextRequest): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const url = new URL(request.url);
  const weekStart = parseWeekStart(url.searchParams.get('weekStart'));
  const weekEnd = new Date(weekStart.getTime() + 7 * MS_PER_DAY);
  const prev = new Date(weekStart.getTime() - 7 * MS_PER_DAY);
  const next = new Date(weekStart.getTime() + 7 * MS_PER_DAY);

  const rows = await db
    .select({
      id: planItems.id,
      kind: planItems.kind,
      state: planItems.state,
      channel: planItems.channel,
      scheduledAt: planItems.scheduledAt,
      title: planItems.title,
      description: planItems.description,
      phase: planItems.phase,
    })
    .from(planItems)
    .where(
      and(
        eq(planItems.userId, userId),
        gte(planItems.scheduledAt, weekStart),
        lt(planItems.scheduledAt, weekEnd),
        ne(planItems.state, 'superseded'),
        ne(planItems.state, 'stale'),
      ),
    )
    .orderBy(planItems.scheduledAt);

  // Bucket by UTC YYYY-MM-DD. Seed all 7 days so the UI can render empty
  // columns without a client-side gap-filling pass.
  const byDay = new Map<string, CalendarItemDTO[]>();
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(weekStart.getTime() + i * MS_PER_DAY);
    byDay.set(toYmd(d), []);
  }
  let scheduled = 0;
  let completed = 0;
  let skipped = 0;
  for (const r of rows) {
    const key = toYmd(r.scheduledAt);
    const bucket = byDay.get(key);
    if (!bucket) continue; // shouldn't happen — weekEnd exclusive bound
    bucket.push({
      id: r.id,
      kind: r.kind as CalendarKind,
      state: r.state as PlanItemState,
      channel: r.channel ?? null,
      scheduledAt: r.scheduledAt.toISOString(),
      title: r.title,
      description: r.description ?? null,
      phase: r.phase,
    });
    if (r.state === 'completed') completed += 1;
    else if (r.state === 'skipped') skipped += 1;
    else scheduled += 1;
  }

  const days: CalendarDay[] = Array.from(byDay.entries()).map(
    ([date, items]) => ({ date, items }),
  );

  const payload: CalendarResponse = {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    prev: prev.toISOString(),
    next: next.toISOString(),
    days,
    totals: { scheduled, completed, skipped },
  };

  return NextResponse.json(payload);
}
