'use client';

// UI-B Task 8: TeammateRoster sidebar.
//
// Renders the team's live roster — the lead row pinned at top, then any
// non-terminal teammate `agent_runs` grouped under their parent (the
// lead's `agentId`). Reuses `<AgentStatusPill>` for the status indicator
// vocabulary (see UI-B Task 1, commit 2216c2a).
//
// Initial state comes from the parent (which fetches
// `/api/team/[teamId]/teammates` on the server). Live updates flow via
// `useTeamEvents` listening for `agent_status_change` payloads on
// `team:${teamId}:messages` — same channel the chat already subscribes
// to, with the messageType discriminator filtering out non-status
// events.
//
// Per the UI-B spec the per-teammate "stop" button is wired in Task 11
// (`/api/team/agent/[agentId]/cancel`); for now it surfaces as a
// no-op stub so the surface is feature-complete on hover and callers
// can pass `onStop` when the cancel route lands.

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { AgentStatusPill, type AgentStatus } from './agent-status-pill';
import {
  useTeamEvents,
  type TeamActivityMessage,
} from '@/hooks/use-team-events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RosterTeammate {
  agentId: string;
  memberId: string;
  agentDefName: string;
  parentAgentId: string | null;
  status: AgentStatus;
  lastActiveAt: string;
  sleepUntil: string | null;
  displayName: string;
}

export interface RosterLead {
  /** `agent_runs.id` — null when the lead has never run yet. */
  agentId: string | null;
  memberId: string;
  agentDefName: string;
  displayName: string;
  /** Lead lifecycle position; null when the lead has never run. */
  status: AgentStatus | null;
  lastActiveAt: string | null;
}

export interface TeammateRosterProps {
  teamId: string;
  initialLead: RosterLead | null;
  initialTeammates: readonly RosterTeammate[];
  /**
   * Optional cancel handler — wired to the per-teammate cancel endpoint
   * by UI-B Task 11. Until that ships, callers leave it undefined and the
   * stop button is rendered as a no-op for hover affordance only.
   */
  onStop?: (agentId: string) => void;
}

// ---------------------------------------------------------------------------
// SSE event narrowing
// ---------------------------------------------------------------------------

interface StatusChangePayload {
  agentId: string;
  status: AgentStatus;
  lastActiveAt: string;
  displayName?: string | null;
}

function isStatusChangeEvent(
  msg: TeamActivityMessage,
): msg is TeamActivityMessage & { metadata: Record<string, unknown> | null } {
  return msg.type === 'agent_status_change';
}

function readStatusChange(msg: TeamActivityMessage): StatusChangePayload | null {
  if (!isStatusChangeEvent(msg)) return null;
  // The publisher (`agent-run.ts publishStatusChange`) flattens fields
  // onto the payload; the SSE route forwards them onto the wire wrapper.
  // Most flat fields land on the message via `useTeamEvents` typing, but
  // anything outside the canonical TeamActivityMessage shape is preserved
  // on `metadata` only when nested. Read both shapes defensively so the
  // hook's evolution doesn't silently break the roster.
  const meta = msg.metadata as Record<string, unknown> | null;
  const raw = msg as unknown as Record<string, unknown>;
  const agentId = pickString(raw['agentId']) ?? pickString(meta?.['agentId']);
  const status = pickString(raw['status']) ?? pickString(meta?.['status']);
  const lastActiveAt =
    pickString(raw['lastActiveAt']) ?? pickString(meta?.['lastActiveAt']);
  if (!agentId || !status || !lastActiveAt) return null;
  if (!isAgentStatus(status)) return null;
  const displayNameRaw =
    pickString(raw['displayName']) ?? pickString(meta?.['displayName']);
  return {
    agentId,
    status,
    lastActiveAt,
    displayName: displayNameRaw ?? null,
  };
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'sleeping',
  'queued',
  'running',
  'resuming',
  'completed',
  'failed',
  'killed',
]);

function isAgentStatus(value: string): value is AgentStatus {
  return AGENT_STATUSES.has(value as AgentStatus);
}

const TERMINAL_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'completed',
  'failed',
  'killed',
]);

// ---------------------------------------------------------------------------
// Reducer-style state updaters (keep the SSE handler free of mutation)
// ---------------------------------------------------------------------------

interface RosterState {
  lead: RosterLead | null;
  teammates: readonly RosterTeammate[];
}

function applyStatusChange(
  state: RosterState,
  ev: StatusChangePayload,
): RosterState {
  // Lead branch: match by agentId. Lead status NEVER removes — even on a
  // terminal payload we keep the row visible (it's "always present"); we
  // just record the new status so the pill reflects reality.
  if (state.lead && state.lead.agentId === ev.agentId) {
    return {
      ...state,
      lead: {
        ...state.lead,
        status: ev.status,
        lastActiveAt: ev.lastActiveAt,
      },
    };
  }

  const idx = state.teammates.findIndex((t) => t.agentId === ev.agentId);

  // Teammate branch: terminal status removes the row from the live list.
  if (TERMINAL_STATUSES.has(ev.status)) {
    if (idx === -1) return state;
    return {
      ...state,
      teammates: state.teammates.filter((t) => t.agentId !== ev.agentId),
    };
  }

  // Existing teammate, non-terminal: patch in place.
  if (idx !== -1) {
    const updated = state.teammates.map((t) =>
      t.agentId === ev.agentId
        ? { ...t, status: ev.status, lastActiveAt: ev.lastActiveAt }
        : t,
    );
    return { ...state, teammates: updated };
  }

  // Unknown teammate, non-terminal: a new spawn we haven't hydrated yet.
  // Append a stub row using whatever fields the SSE payload carries; the
  // next page reload will fill in the rest from the team-state cache.
  // This keeps the roster from missing a "queued" indicator on a fresh
  // Task tool spawn.
  if (ev.displayName) {
    const stub: RosterTeammate = {
      agentId: ev.agentId,
      memberId: '',
      agentDefName: '',
      parentAgentId: state.lead?.agentId ?? null,
      status: ev.status,
      lastActiveAt: ev.lastActiveAt,
      sleepUntil: null,
      displayName: ev.displayName,
    };
    return { ...state, teammates: [...state.teammates, stub] };
  }
  return state;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function rosterStyles(): { wrap: CSSProperties; header: CSSProperties; list: CSSProperties; empty: CSSProperties } {
  return {
    wrap: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      padding: '12px 8px',
      background: 'var(--sf-bg-secondary, transparent)',
      width: '100%',
      minWidth: 0,
    },
    header: {
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: 'var(--sf-fg-3)',
      padding: '0 8px 6px 8px',
    },
    list: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    },
    empty: {
      fontSize: 12,
      color: 'var(--sf-fg-3)',
      padding: '6px 8px 0 8px',
      fontStyle: 'italic',
    },
  };
}

interface RowProps {
  agentId: string | null;
  displayName: string;
  agentDefName?: string;
  status: AgentStatus | null;
  isLead?: boolean;
  onStop?: () => void;
}

function rowStyles(): {
  outer: CSSProperties;
  inner: CSSProperties;
  name: CSSProperties;
  meta: CSSProperties;
  trailing: CSSProperties;
  stop: CSSProperties;
} {
  return {
    outer: {
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 10px',
      borderRadius: 8,
      background: 'transparent',
      transition: 'background 160ms var(--sf-ease-swift, ease-out)',
      minWidth: 0,
    },
    inner: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      flex: 1,
      minWidth: 0,
    },
    name: {
      fontSize: 13,
      fontWeight: 500,
      color: 'var(--sf-fg-1)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    meta: {
      fontSize: 10,
      fontFamily: 'var(--sf-font-mono)',
      color: 'var(--sf-fg-4)',
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    trailing: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      flexShrink: 0,
    },
    stop: {
      // Stop button is hover-revealed via CSS in a real shipping pass;
      // for the MVP we leave it always-rendered when the row is
      // stoppable so hit-testing in Playwright is straightforward. The
      // parent rail can opt into hover-only via `onStop` gating + CSS
      // once the design surface lands.
      width: 22,
      height: 22,
      borderRadius: 6,
      border: '1px solid var(--sf-border, rgba(0,0,0,0.12))',
      background: 'transparent',
      color: 'var(--sf-fg-3)',
      cursor: 'pointer',
      fontSize: 11,
      lineHeight: 1,
      padding: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
  };
}

function isStoppable(status: AgentStatus | null): boolean {
  return status === 'running' || status === 'sleeping';
}

function RosterRow({
  agentId,
  displayName,
  agentDefName,
  status,
  isLead,
  onStop,
}: RowProps): ReactNode {
  const styles = rowStyles();
  return (
    <div
      style={styles.outer}
      data-testid={isLead ? 'teammate-roster-lead' : 'teammate-roster-row'}
      data-agent-id={agentId ?? ''}
      data-status={status ?? 'idle'}
    >
      <div style={styles.inner}>
        <span style={styles.name}>{displayName}</span>
        {agentDefName ? <span style={styles.meta}>{agentDefName}</span> : null}
      </div>
      <span style={styles.trailing}>
        {status ? (
          <AgentStatusPill status={status} />
        ) : (
          <span style={styles.meta}>idle</span>
        )}
        {!isLead && isStoppable(status) && agentId && onStop ? (
          <button
            type="button"
            aria-label={`Stop ${displayName}`}
            data-testid="teammate-roster-stop"
            style={styles.stop}
            onClick={(e) => {
              e.stopPropagation();
              onStop();
            }}
          >
            ×
          </button>
        ) : null}
      </span>
    </div>
  );
}

export function TeammateRoster({
  teamId,
  initialLead,
  initialTeammates,
  onStop,
}: TeammateRosterProps): ReactNode {
  const [state, setState] = useState<RosterState>(() => ({
    lead: initialLead,
    teammates: [...initialTeammates],
  }));

  // Re-seed when the parent re-fetches (e.g. after a navigation): the
  // initial props become the new authoritative snapshot.
  useEffect(() => {
    setState({ lead: initialLead, teammates: [...initialTeammates] });
  }, [initialLead, initialTeammates]);

  useTeamEvents({
    teamId,
    onMessage: (msg) => {
      const ev = readStatusChange(msg);
      if (!ev) return;
      setState((prev) => applyStatusChange(prev, ev));
    },
    // No `filter` — the chat surface in `team-desk.tsx` also subscribes
    // to this channel; sharing the connection per-tab is fine because
    // EventSource multiplexes inside the browser.
  });

  // Sort teammates by spawn order (lastActiveAt as a proxy until the
  // cache exposes spawnedAt directly): newest at the bottom keeps the
  // "first spawned, first listed" reading order.
  const orderedTeammates = useMemo(() => {
    return [...state.teammates].sort((a, b) =>
      a.lastActiveAt.localeCompare(b.lastActiveAt),
    );
  }, [state.teammates]);

  const styles = rosterStyles();

  return (
    <aside style={styles.wrap} aria-label="Team roster" data-testid="teammate-roster">
      <div style={styles.header}>Roster</div>
      <div style={styles.list}>
        {state.lead ? (
          <RosterRow
            agentId={state.lead.agentId}
            displayName={state.lead.displayName}
            agentDefName={state.lead.agentDefName}
            status={state.lead.status}
            isLead
            onStop={
              state.lead.agentId && onStop
                ? () => onStop(state.lead!.agentId!)
                : undefined
            }
          />
        ) : null}
        {orderedTeammates.length === 0 ? (
          <div style={styles.empty} data-testid="teammate-roster-empty">
            No active teammates
          </div>
        ) : (
          orderedTeammates.map((t) => (
            <RosterRow
              key={t.agentId}
              agentId={t.agentId}
              displayName={t.displayName}
              agentDefName={t.agentDefName}
              status={t.status}
              onStop={onStop ? () => onStop(t.agentId) : undefined}
            />
          ))
        )}
      </div>
    </aside>
  );
}
