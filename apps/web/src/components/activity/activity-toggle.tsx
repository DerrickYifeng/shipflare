'use client';

// ActivityToggle — the collapsible "Activity (N) ▾" header button
// (Task 13 of plan 2026-05-15-agent-activity-feed.md).
//
// Pure stateless button. Caller owns `open` state.

export interface ActivityToggleProps {
  count: number;
  open: boolean;
  onToggle: () => void;
}

export function ActivityToggle({ count, open, onToggle }: ActivityToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
    >
      <span>Activity ({count})</span>
      <span aria-hidden>{open ? '▾' : '▸'}</span>
    </button>
  );
}
