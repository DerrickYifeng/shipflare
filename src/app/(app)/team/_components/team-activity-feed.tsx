'use client';

// UI-B Task 10: right-sidebar activity feed.
//
// Chronological one-line entries for cross-agent events the founder
// cares about as transparency, NOT as part of the lead's main chat:
//   - `agent_status_change` — published by `agent-run.ts publishStatusChange`
//   - `task_notification`   — published by `agent-run.ts publishTaskNotification`
//                              (after `synthAndDeliverNotification` persists)
//   - `peer_dm`             — published by `peer-dm-shadow.ts insertPeerDmShadow`
//                              (after the shadow row insert; no wake)
//
// Defensive: any other event types are silently dropped so adding a new
// SSE message type elsewhere doesn't crash old clients.

import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  useTeamEvents,
  type TeamActivityMessage,
} from '@/hooks/use-team-events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeedEventKind = 'status' | 'notification' | 'peer_dm';

export interface FeedEvent {
  /** Unique id used as React key + dedupe guard. */
  id: string;
  kind: FeedEventKind;
  timestamp: string;
  summary: string;
}

export interface TeamActivityFeedProps {
  teamId: string;
  /**
   * Maximum number of feed entries kept in memory. Defaults to 100 —
   * beyond that the oldest entries are evicted so the sidebar doesn't
   * grow unbounded across long sessions. The page reload + initial
   * snapshot reseeds from durable rows when needed.
   */
  maxEvents?: number;
}

const DEFAULT_MAX_EVENTS = 100;

// ---------------------------------------------------------------------------
// Event normalizers — read defensively from both the wire wrapper's
// flat fields and the legacy `metadata` nest. Mirrors the pattern used
// by teammate-roster.tsx so the feed's evolution doesn't silently break
// if the SSE payload shape shifts.
// ---------------------------------------------------------------------------

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readField(msg: TeamActivityMessage, key: string): string | null {
  const meta = msg.metadata as Record<string, unknown> | null;
  const raw = msg as unknown as Record<string, unknown>;
  return pickString(raw[key]) ?? pickString(meta?.[key]);
}

function isoTimestamp(msg: TeamActivityMessage): string {
  return msg.createdAt ?? new Date().toISOString();
}

function normalizeStatusChange(msg: TeamActivityMessage): FeedEvent | null {
  const status = readField(msg, 'status');
  if (!status) return null;
  const displayName = readField(msg, 'displayName') ?? 'Agent';
  return {
    id: msg.id,
    kind: 'status',
    timestamp: isoTimestamp(msg),
    summary: `${displayName} → ${status}`,
  };
}

function normalizeTaskNotification(msg: TeamActivityMessage): FeedEvent | null {
  const status = readField(msg, 'status');
  if (!status) return null;
  const summary = readField(msg, 'summary') ?? '(no summary)';
  const teammateName = readField(msg, 'teammateName') ?? 'Teammate';
  return {
    id: msg.id,
    kind: 'notification',
    timestamp: isoTimestamp(msg),
    summary: `${teammateName} ${status}: ${summary}`,
  };
}

function normalizePeerDm(msg: TeamActivityMessage): FeedEvent | null {
  const from = readField(msg, 'from');
  const to = readField(msg, 'to');
  const summary = readField(msg, 'summary') ?? '(no summary)';
  if (!from || !to) return null;
  return {
    id: msg.id,
    kind: 'peer_dm',
    timestamp: isoTimestamp(msg),
    summary: `${from} → ${to}: ${summary}`,
  };
}

function normalizeMessage(msg: TeamActivityMessage): FeedEvent | null {
  switch (msg.type) {
    case 'agent_status_change':
      return normalizeStatusChange(msg);
    case 'task_notification':
      return normalizeTaskNotification(msg);
    case 'peer_dm':
      return normalizePeerDm(msg);
    default:
      // Defensive: silently ignore any event type the feed doesn't know
      // about. New SSE types added elsewhere shouldn't crash the UI.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function feedStyles(): {
  wrap: CSSProperties;
  header: CSSProperties;
  list: CSSProperties;
  empty: CSSProperties;
  item: CSSProperties;
  time: CSSProperties;
  body: CSSProperties;
  kindBadge: CSSProperties;
} {
  return {
    wrap: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: '12px 12px 16px 12px',
      background: 'var(--sf-bg-secondary, transparent)',
      borderLeft: '1px solid var(--sf-border, rgba(0,0,0,0.08))',
      width: '100%',
      minWidth: 0,
      height: '100%',
      overflowY: 'auto',
    },
    header: {
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: 'var(--sf-fg-3)',
      padding: '0 4px 4px 4px',
      flexShrink: 0,
    },
    list: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      listStyle: 'none',
      margin: 0,
      padding: 0,
    },
    empty: {
      fontSize: 12,
      color: 'var(--sf-fg-3)',
      fontStyle: 'italic',
      padding: '6px 4px',
    },
    item: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      padding: '6px 8px',
      borderRadius: 6,
      background: 'transparent',
    },
    time: {
      fontSize: 10,
      fontFamily: 'var(--sf-font-mono)',
      color: 'var(--sf-fg-4)',
      letterSpacing: 0.4,
    },
    body: {
      fontSize: 12,
      color: 'var(--sf-fg-2)',
      lineHeight: 1.4,
      wordBreak: 'break-word',
    },
    kindBadge: {
      display: 'inline-block',
      fontSize: 9,
      fontFamily: 'var(--sf-font-mono)',
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      padding: '1px 5px',
      borderRadius: 4,
      marginRight: 6,
      verticalAlign: 'middle',
    },
  };
}

function kindBadgeTone(kind: FeedEventKind): { fg: string; bg: string } {
  switch (kind) {
    case 'status':
      return { fg: 'var(--sf-accent)', bg: 'var(--sf-accent-light)' };
    case 'notification':
      return { fg: 'var(--sf-success-ink)', bg: 'var(--sf-success-light)' };
    case 'peer_dm':
      return { fg: 'var(--sf-fg-3)', bg: 'rgba(0,0,0,0.05)' };
  }
}

function kindBadgeLabel(kind: FeedEventKind): string {
  switch (kind) {
    case 'status':
      return 'status';
    case 'notification':
      return 'done';
    case 'peer_dm':
      return 'peer';
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TeamActivityFeed({
  teamId,
  maxEvents = DEFAULT_MAX_EVENTS,
}: TeamActivityFeedProps): ReactNode {
  const [events, setEvents] = useState<FeedEvent[]>([]);

  useTeamEvents({
    teamId,
    onMessage: (msg) => {
      const evt = normalizeMessage(msg);
      if (!evt) return;
      setEvents((prev) => {
        // Dedupe by id — SSE snapshot replay can re-deliver entries the
        // feed already showed. Keep newest-first ordering by prepending.
        if (prev.some((e) => e.id === evt.id)) return prev;
        const next = [evt, ...prev];
        return next.length > maxEvents ? next.slice(0, maxEvents) : next;
      });
    },
  });

  const styles = feedStyles();
  return (
    <aside style={styles.wrap} aria-label="Team activity" data-testid="team-activity-feed">
      <div style={styles.header}>Activity</div>
      {events.length === 0 ? (
        <div style={styles.empty} data-testid="team-activity-feed-empty">
          No activity yet
        </div>
      ) : (
        <ul style={styles.list}>
          {events.map((e) => {
            const tone = kindBadgeTone(e.kind);
            const badge: CSSProperties = {
              ...styles.kindBadge,
              color: tone.fg,
              background: tone.bg,
            };
            return (
              <li
                key={e.id}
                style={styles.item}
                data-testid="team-activity-feed-item"
                data-kind={e.kind}
              >
                <span style={styles.time}>
                  <time dateTime={e.timestamp}>
                    {formatTime(e.timestamp)}
                  </time>
                </span>
                <span style={styles.body}>
                  <span style={badge} aria-hidden="true">
                    {kindBadgeLabel(e.kind)}
                  </span>
                  {e.summary}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function formatTime(iso: string): string {
  // Server-rendered initial paint vs client clock drift: fall back to
  // the raw timestamp if Date construction fails so the feed entry
  // still renders something readable.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
