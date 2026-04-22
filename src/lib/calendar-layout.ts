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
      // Expand across the duration. e.g. 60m starting 09:00 lights 9 and
      // 10 (since the block ends at 10:00 exclusive we only need hour 9,
      // but lighting hour 10 keeps a 1h buffer around meetings).
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
