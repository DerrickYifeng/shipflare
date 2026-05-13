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
// Visual treatment mirrors the in-conversation SubtaskCard so the user sees
// a familiar card shape, NOT a tiny pill. Vertical scroll inside a bounded
// height keeps the rail readable even with many concurrent dispatches.
//
// Recently-completed teammates linger for `RECENT_COMPLETED_TTL_MS` so the
// user still sees them resolve before they vanish.

const RECENT_COMPLETED_TTL_MS = 30_000;

/** Maximum rail height before vertical scrolling kicks in. */
const RAIL_MAX_HEIGHT_PX = 320;

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
  /**
   * Founder-facing display name. Prefer the subtask description ("fill x
   * reply slot") over the bare agent type ("Social Media Manager") so the
   * rail surfaces what the teammate is actually doing.
   */
  name: string;
  /**
   * Optional second line — typically the agent type ("Social Media
   * Manager") rendered alongside the name. When omitted, only the name
   * shows. Matches the in-conversation SubtaskCard layout.
   */
  subtitle?: string;
  status: RailStatus;
  /**
   * Epoch ms — used both to TTL-out terminal entries and to sort within
   * a status family (most-recent first). The caller is responsible for
   * deriving this from the underlying `agent_runs.last_active_at` or the
   * SSE event's `lastActiveAt` payload.
   */
  lastActiveAt: number;
  /**
   * Optional accent color for the left-rule. Allows the rail card to
   * match the agent-type color used elsewhere (e.g. SubtaskCard accent).
   * Falls back to neutral border when absent.
   */
  accent?: string;
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
    borderLeft: '1px solid var(--sf-border, rgba(0, 0, 0, 0.08))',
    borderRight: '1px solid var(--sf-border, rgba(0, 0, 0, 0.08))',
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    background: 'var(--sf-bg-secondary, rgba(245, 245, 247, 0.92))',
    backdropFilter: 'blur(10px)',
    padding: '10px 12px',
    boxShadow: '0 -4px 16px rgba(0, 0, 0, 0.04)',
  };

  const header: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 4px 8px',
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: 'var(--sf-fg-3)',
  };

  const scroller: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    overflowY: 'auto',
    overflowX: 'hidden',
    maxHeight: RAIL_MAX_HEIGHT_PX,
  };

  return (
    <div
      role="region"
      aria-label="Active teammates"
      data-testid="active-subagents-rail"
      style={region}
    >
      <div style={header}>
        <span>● Dispatch</span>
        <span>·</span>
        <span>
          {visible.length} active
        </span>
      </div>
      <div style={scroller}>
        {visible.map((s) => (
          <RailCard key={s.id} subagent={s} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

interface RailCardProps {
  subagent: RailSubagent;
  onSelect?: (id: string) => void;
}

function RailCard({ subagent, onSelect }: RailCardProps) {
  const isActive = ACTIVE_STATUSES.has(subagent.status);
  const clickable = !!onSelect;
  const card: CSSProperties = {
    position: 'relative',
    width: '100%',
    textAlign: 'left',
    display: 'block',
    padding: '10px 12px 10px 16px',
    borderRadius: 8,
    border: '1px solid rgba(0, 0, 0, 0.05)',
    background: 'var(--sf-bg-primary, #fff)',
    fontFamily: 'inherit',
    color: 'var(--sf-fg-1)',
    cursor: clickable ? 'pointer' : 'default',
    transition: 'background 160ms var(--sf-ease-swift, ease-out)',
    // Recently-completed entries fade slightly so the active set reads
    // as the primary focus.
    opacity: isActive ? 1 : 0.65,
  };

  const leftRule: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 10,
    bottom: 10,
    width: 3,
    borderRadius: 2,
    background: subagent.accent ?? 'var(--sf-border, rgba(0, 0, 0, 0.15))',
  };

  const topRow: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  };

  const titleCol: CSSProperties = {
    minWidth: 0,
    flex: 1,
  };

  const title: CSSProperties = {
    fontSize: 14,
    fontWeight: 600,
    lineHeight: 1.3,
    color: 'var(--sf-fg-1)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  const subtitle: CSSProperties = {
    marginTop: 2,
    fontSize: 10,
    fontFamily: 'var(--sf-font-mono)',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: 'var(--sf-fg-3)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  const statusPill: CSSProperties = {
    flexShrink: 0,
    fontSize: 10,
    fontFamily: 'var(--sf-font-mono)',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: 'var(--sf-fg-3)',
    background: 'var(--sf-bg-secondary, rgba(0, 0, 0, 0.04))',
    padding: '2px 8px',
    borderRadius: 999,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  };

  const dot: CSSProperties = {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background:
      subagent.status === 'running'
        ? 'var(--sf-positive, #34c759)'
        : subagent.status === 'queued'
          ? 'var(--sf-warning, #ff9500)'
          : subagent.status === 'sleeping'
            ? 'var(--sf-fg-3, #999)'
            : 'var(--sf-fg-3, #999)',
    animation: subagent.status === 'running' ? 'rail-pulse 1.4s ease-in-out infinite' : undefined,
  };

  return (
    <button
      type="button"
      onClick={clickable ? () => onSelect(subagent.id) : undefined}
      data-testid="rail-card"
      data-agent-id={subagent.id}
      data-status={subagent.status}
      aria-label={`${subagent.name}, ${statusLabel(subagent.status)}`}
      style={card}
    >
      <span style={leftRule} aria-hidden />
      <div style={topRow}>
        <div style={titleCol}>
          <div data-testid="rail-name" style={title}>
            {subagent.name}
          </div>
          {subagent.subtitle && (
            <div style={subtitle}>{subagent.subtitle} · subtask</div>
          )}
        </div>
        <span style={statusPill}>
          <span style={dot} aria-hidden />
          {statusLabel(subagent.status)}
        </span>
      </div>
      <style jsx>{`
        @keyframes rail-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </button>
  );
}
