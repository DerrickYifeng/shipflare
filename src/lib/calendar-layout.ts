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
