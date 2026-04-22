/**
 * Pure layout helpers for the /calendar time grid. No React, no DOM.
 *
 * Consumed by `src/app/(app)/calendar/calendar-content.tsx`. All rendering
 * constants (hour height, band height, overflow threshold) are passed in by
 * the caller so tests can pin exact values.
 */

export type PlanItemKind =
  | 'content_post'
  | 'content_reply'
  | 'email_send'
  | 'interview'
  | 'setup_task'
  | 'launch_asset'
  | 'runsheet_beat'
  | 'metrics_compute'
  | 'analytics_summary';

/**
 * Synthetic duration for a plan item. `plan_items` stores only a start time;
 * the calendar view fakes a visual block length per kind. See the spec for
 * the rationale (meetings read longer than posts).
 */
export function durationForKind(kind: PlanItemKind): number {
  switch (kind) {
    case 'content_post':
    case 'content_reply':
    case 'email_send':
    case 'analytics_summary':
    case 'metrics_compute':
    case 'launch_asset':
      return 30;
    case 'interview':
    case 'setup_task':
    case 'runsheet_beat':
      return 60;
  }
}

export type PlanItemState =
  | 'planned'
  | 'drafted'
  | 'ready_for_review'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'superseded'
  | 'stale';

export interface CalendarItem {
  id: string;
  kind: PlanItemKind;
  state: PlanItemState;
  channel: string | null;
  scheduledAt: string;
  title: string;
  description: string | null;
  phase: string;
}

export interface CalendarDay {
  date: string;
  items: CalendarItem[];
}

export interface CollapsedBand {
  startHour: number; // inclusive, 0-23
  endHour: number; // exclusive, 1-24
}

export const BAND_COLLAPSE_MIN_HOURS = 3;

/**
 * Compute which hours of the day are "used" across the visible week and
 * which contiguous ≥3h runs of unused hours should render as a single
 * band. Used hours are computed as `max over 7 days` so hour labels on
 * the left rail stay aligned across columns.
 */
export function computeCollapsedBands(days: CalendarDay[]): {
  usedHours: Set<number>;
  bands: CollapsedBand[];
} {
  const usedHours = new Set<number>();

  for (const d of days) {
    for (const item of d.items) {
      const start = new Date(item.scheduledAt);
      const startHour = start.getUTCHours();
      const minutes = durationForKind(item.kind);
      // Expand across the event's duration. e.g.:
      //   30m at 08:45 -> endMinutes=555, ceil(555/60)=10, loop h=8,9.
      //   60m at 09:00 -> endMinutes=600, ceil(600/60)=10, loop h=9 only.
      // Events assumed to fall within a single UTC day; cross-midnight
      // items are out of scope.
      const endMinutes = startHour * 60 + start.getUTCMinutes() + minutes;
      const endHourExclusive = Math.ceil(endMinutes / 60);
      for (let h = startHour; h < endHourExclusive && h < 24; h += 1) {
        usedHours.add(h);
      }
    }
  }

  const bands: CollapsedBand[] = [];
  let runStart: number | null = null;
  for (let h = 0; h <= 24; h += 1) {
    const isUsed = h < 24 && usedHours.has(h);
    if (!isUsed && runStart === null) {
      runStart = h;
    }
    if ((isUsed || h === 24) && runStart !== null) {
      const runLength = h - runStart;
      if (runLength >= BAND_COLLAPSE_MIN_HOURS) {
        bands.push({ startHour: runStart, endHour: h });
      }
      runStart = null;
    }
  }

  return { usedHours, bands };
}

/**
 * Convert a clock offset (minutes from midnight) to a pixel offset in the
 * rendered time grid, skipping past any collapsed bands that fall strictly
 * before the offset. Bands that straddle the offset shouldn't happen in
 * practice (bands only cover unused hours and an event's hour is always
 * used); defensively we treat them as if the offset landed at the band's
 * start.
 */
export function hourToTopPx(
  minutesFromMidnight: number,
  bands: CollapsedBand[],
  hourHeightPx: number,
  bandHeightPx: number,
): number {
  let px = 0;
  let minutesConsumed = 0;

  for (let h = 0; h < 24; h += 1) {
    if (minutesConsumed >= minutesFromMidnight) break;

    const band = bands.find((b) => b.startHour === h);
    if (band) {
      const bandEndMinutes = band.endHour * 60;
      if (minutesFromMidnight >= bandEndMinutes) {
        // Offset is past the band — consume the whole band as one row.
        px += bandHeightPx;
        minutesConsumed = bandEndMinutes;
        h = band.endHour - 1; // loop will re-increment
        continue;
      }
      // Defensive: offset inside the band — stop at the band's top edge.
      break;
    }

    const hourEndMinutes = (h + 1) * 60;
    const chunkMinutes =
      Math.min(hourEndMinutes, minutesFromMidnight) - h * 60;
    px += (chunkMinutes / 60) * hourHeightPx;
    minutesConsumed = Math.min(hourEndMinutes, minutesFromMidnight);
  }

  return px;
}

export interface PositionedEvent {
  item: CalendarItem;
  topPx: number;
  heightPx: number;
  leftPct: number;
  widthPct: number;
  isOverflowPill?: boolean;
  /** Ids of the extra events collapsed into the pill. */
  overflowIds?: string[];
}

interface EventWithSpan {
  item: CalendarItem;
  startMinutes: number;
  endMinutes: number;
}

function toSpan(item: CalendarItem): EventWithSpan {
  const d = new Date(item.scheduledAt);
  const startMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const endMinutes = startMinutes + durationForKind(item.kind);
  return { item, startMinutes, endMinutes };
}

/**
 * Layout all events for a single day into absolutely-positioned boxes.
 * Non-overlapping events occupy the full column width; overlap grouping
 * and overflow-pill logic are added in later tasks.
 *
 * `columnWidthPx` is unused at this stage — Task 5 adds grouping and
 * Task 6 reads it to decide when to emit an overflow pill.
 */
export function layoutDayEvents(
  items: CalendarItem[],
  bands: CollapsedBand[],
  hourHeightPx: number,
  bandHeightPx: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  columnWidthPx: number,
): PositionedEvent[] {
  const spans = items
    .map(toSpan)
    .sort((a, b) => a.startMinutes - b.startMinutes);

  return spans.map((s) => {
    const topPx = hourToTopPx(s.startMinutes, bands, hourHeightPx, bandHeightPx);
    const bottomPx = hourToTopPx(s.endMinutes, bands, hourHeightPx, bandHeightPx);
    return {
      item: s.item,
      topPx,
      heightPx: Math.max(bottomPx - topPx, 20),
      leftPct: 0,
      widthPct: 100,
    };
  });
}
