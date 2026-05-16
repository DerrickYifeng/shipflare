'use client';

// ActivityRow — one row of the activity trail (Task 13 of plan
// 2026-05-15-agent-activity-feed.md).
//
// Pure presentational. Takes a pre-computed `ActivityLabel`, a status, and
// optional indent. Renders an icon (◐ / ✓ / ✕) + headline + sub line.
//
// `data-activity-row` + `data-event-id` attributes are emitted on the root
// so Task 17's Playwright smoke can assert against specific events.

import type { ActivityLabel } from '@/lib/activity-labels';

export interface ActivityRowProps {
  /** The event id this row corresponds to. Exposed via `data-event-id`. */
  eventId: string;
  label: ActivityLabel;
  status: 'running' | 'done' | 'error';
  /** Number of indent levels (16px each). Defaults to 0. */
  indent?: number;
}

export function ActivityRow({
  eventId,
  label,
  status,
  indent = 0,
}: ActivityRowProps) {
  const icon = status === 'running' ? '◐' : status === 'error' ? '✕' : '✓';
  return (
    <div
      data-activity-row
      data-event-id={eventId}
      className={`flex items-start gap-2 py-1 text-sm ${
        status === 'error' ? 'text-red-600' : 'text-gray-700'
      }`}
      style={{ paddingLeft: indent * 16 }}
    >
      <span className="w-4 shrink-0 text-center" aria-hidden>
        {status === 'running' ? (
          <span className="inline-block animate-pulse">{icon}</span>
        ) : (
          icon
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate">{label.headline}</div>
        {label.sub ? (
          <div className="truncate text-xs text-gray-500">{label.sub}</div>
        ) : null}
      </div>
    </div>
  );
}
