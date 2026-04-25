/**
 * Week boundary helpers — single source of truth.
 *
 * The codebase has used three identical inline copies of "Monday 00:00 UTC of
 * the week containing `now`" in calendar/route.ts, re-plan.ts, and
 * product/phase/route.ts. Consolidate so a future tweak (e.g. moving to
 * Sunday-as-week-start, or per-locale week starts) lands in one place.
 *
 * Conventions:
 * - Week starts Monday 00:00 UTC.
 * - Week ends the next Monday 00:00 UTC (exclusive upper bound).
 * - `currentWeekStart(now)` is identical to `weekBounds(now).weekStart`.
 */

const MS_PER_DAY = 86_400_000;

/** Monday 00:00 UTC of the ISO week containing `d`. */
export function currentWeekStart(d: Date): Date {
  const w = new Date(d);
  w.setUTCHours(0, 0, 0, 0);
  // d.getUTCDay(): Sun=0..Sat=6; we want Mon=0..Sun=6.
  const dayOffset = (w.getUTCDay() + 6) % 7;
  w.setUTCDate(w.getUTCDate() - dayOffset);
  return w;
}

/** [Monday-of-current-week, Monday-of-next-week) bounds. */
export function weekBounds(now: Date): { weekStart: Date; weekEnd: Date } {
  const weekStart = currentWeekStart(now);
  const weekEnd = new Date(weekStart.getTime() + 7 * MS_PER_DAY);
  return { weekStart, weekEnd };
}
