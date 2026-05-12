'use client';

import type { CSSProperties } from 'react';

// A2: sticky bottom rail for in-flight subagents (engine TaskListV2 pattern).
//
// Today an in-flight subagent appears inside the message stream — as the
// stream grows it can scroll out of view, which is the engine pattern's exact
// failure mode. This rail lives OUTSIDE the conversation's scroll container
// (slotted between the scroll and the StickyComposer in `team-desk.tsx`) so
// active teammates stay visible even when the user scrolls back through
// history.
//
// Recently-completed teammates linger for `RECENT_COMPLETED_TTL_MS` so the
// user still sees them resolve before they vanish.

const RECENT_COMPLETED_TTL_MS = 30_000;

/**
 * Status families surfaced in the rail. Mirrors the `AgentStatus` shape from
 * `agent-status-pill.tsx` minus `resuming` (rolled into `running` for rail
 * intent — both mean "actively working") and minus `killed`/`failed` for
 * routing purposes. Failed / killed are still passed through so the rail can
 * grey them out during the TTL window if the caller chooses to surface them.
 */
export type RailStatus =
  | 'queued'
  | 'running'
  | 'sleeping'
  | 'completed'
  | 'failed'
  | 'killed';

export interface RailSubagent {
  /** `agent_runs.id` — stable across re-renders. */
  id: string;
  /** Founder-facing display name (e.g. "x-replies", "reddit-research"). */
  name: string;
  status: RailStatus;
  /**
   * Epoch ms — used both to TTL-out terminal entries and to sort within
   * a status family (most-recent first). The caller is responsible for
   * deriving this from the underlying `agent_runs.last_active_at` or the
   * SSE event's `lastActiveAt` payload.
   */
  lastActiveAt: number;
}

export interface ActiveSubagentsRailProps {
  subagents: readonly RailSubagent[];
  /**
   * Override `Date.now()` for deterministic tests. Production callers
   * should leave this unset.
   */
  now?: number;
  /**
   * Fired when the user clicks a rail entry. Caller decides whether to
   * scroll the conversation to the matching DelegationCard, focus the
   * right-rail Task panel, or open the teammate transcript drawer.
   */
  onSelect?: (id: string) => void;
}

const ACTIVE_STATUSES: ReadonlySet<RailStatus> = new Set<RailStatus>([
  'queued',
  'running',
  'sleeping',
]);

function isVisible(s: RailSubagent, now: number): boolean {
  if (ACTIVE_STATUSES.has(s.status)) return true;
  return now - s.lastActiveAt < RECENT_COMPLETED_TTL_MS;
}

function priorityForStatus(s: RailStatus): number {
  switch (s) {
    case 'running':
      return 0;
    case 'queued':
      return 1;
    case 'sleeping':
      return 2;
    // Recently-completed/terminal entries linger at the tail.
    case 'completed':
    case 'failed':
    case 'killed':
    default:
      return 3;
  }
}

function statusLabel(status: RailStatus): string {
  if (status === 'completed') return 'done';
  return status;
}

/**
 * Sticky bottom rail. Returns `null` (nothing rendered) when no entries
 * pass the visibility filter, so the caller can drop it into the layout
 * unconditionally without reserving airspace.
 */
export function ActiveSubagentsRail({
  subagents,
  now = Date.now(),
  onSelect,
}: ActiveSubagentsRailProps) {
  const visible = subagents
    .filter((s) => isVisible(s, now))
    .sort((a, b) => {
      const aPri = priorityForStatus(a.status);
      const bPri = priorityForStatus(b.status);
      if (aPri !== bPri) return aPri - bPri;
      // Within a status family, most-recent-active first.
      return b.lastActiveAt - a.lastActiveAt;
    });

  if (visible.length === 0) return null;

  const region: CSSProperties = {
    flexShrink: 0,
    borderTop: '1px solid var(--sf-border, rgba(0, 0, 0, 0.08))',
    background: 'var(--sf-bg-secondary, rgba(245, 245, 247, 0.85))',
    backdropFilter: 'blur(8px)',
    padding: '8px 16px',
  };

  const scroller: CSSProperties = {
    display: 'flex',
    gap: 8,
    overflowX: 'auto',
    overflowY: 'hidden',
  };

  return (
    <div
      role="region"
      aria-label="Active teammates"
      data-testid="active-subagents-rail"
      style={region}
    >
      <div style={scroller}>
        {visible.map((s) => (
          <RailChip key={s.id} subagent={s} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

interface RailChipProps {
  subagent: RailSubagent;
  onSelect?: (id: string) => void;
}

function RailChip({ subagent, onSelect }: RailChipProps) {
  const isActive = ACTIVE_STATUSES.has(subagent.status);
  const chip: CSSProperties = {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 12px',
    borderRadius: 999,
    border: '1px solid var(--sf-border, rgba(0, 0, 0, 0.12))',
    background: 'var(--sf-bg-primary, #fff)',
    fontFamily: 'inherit',
    fontSize: 12,
    color: 'var(--sf-fg-1)',
    cursor: onSelect ? 'pointer' : 'default',
    transition: 'background 160ms var(--sf-ease-swift, ease-out)',
    // Recently-completed entries fade slightly so the active set reads
    // as the primary focus.
    opacity: isActive ? 1 : 0.7,
  };
  const name: CSSProperties = {
    fontWeight: 500,
  };
  const status: CSSProperties = {
    color: 'var(--sf-fg-3)',
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  };
  return (
    <button
      type="button"
      onClick={onSelect ? () => onSelect(subagent.id) : undefined}
      data-testid="rail-chip"
      data-agent-id={subagent.id}
      data-status={subagent.status}
      aria-label={`${subagent.name}, ${statusLabel(subagent.status)}`}
      style={chip}
    >
      <span data-testid="rail-name" style={name}>
        {subagent.name}
      </span>
      <span style={status}>{statusLabel(subagent.status)}</span>
    </button>
  );
}
