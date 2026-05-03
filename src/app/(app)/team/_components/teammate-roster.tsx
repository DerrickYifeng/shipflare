'use client';

// UI-B Task 8 + Task 11: TeammateRoster sidebar.
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
// UI-B Task 11 wires the per-teammate stop button to
// `/api/team/agent/[agentId]/cancel` by default. Callers can pass
// `onStop` to override (e.g. tests assert the prop is invoked); the
// default handler does the real POST and applies an optimistic
// "cancelling…" status until SSE delivers the canonical 'killed'
// transition that removes the row.

import {
  useCallback,
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
   * Optional cancel handler override. When omitted, the roster
   * defaults to POSTing `/api/team/agent/${agentId}/cancel` (UI-B
   * Task 11). Tests pass an explicit handler to assert the click
   * surface without going through fetch. Production callers can leave
   * it undefined — the default is the right behavior.
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
  /**
   * Optimistic cancel marker — set after a successful POST to the
   * cancel endpoint and cleared when SSE delivers status='killed' (and
   * the row is removed). When true the pill swaps its label to
   * "cancelling…" so the user gets immediate feedback without waiting
   * a full agent turn for the real status flip.
   */
  cancelling?: boolean;
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
  cancelling,
}: RowProps): ReactNode {
  const styles = rowStyles();
  return (
    <div
      style={styles.outer}
      data-testid={isLead ? 'teammate-roster-lead' : 'teammate-roster-row'}
      data-agent-id={agentId ?? ''}
      data-status={status ?? 'idle'}
      data-cancelling={cancelling ? 'true' : undefined}
    >
      <div style={styles.inner}>
        <span style={styles.name}>{displayName}</span>
        {agentDefName ? <span style={styles.meta}>{agentDefName}</span> : null}
      </div>
      <span style={styles.trailing}>
        {status ? (
          <AgentStatusPill
            status={status}
            label={cancelling ? 'cancelling…' : undefined}
          />
        ) : (
          <span style={styles.meta}>idle</span>
        )}
        {!isLead && isStoppable(status) && agentId && onStop ? (
          <button
            type="button"
            aria-label={`Stop ${displayName}`}
            data-testid="teammate-roster-stop"
            style={styles.stop}
            disabled={cancelling}
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

/**
 * Default cancel handler — POSTs `/api/team/agent/${agentId}/cancel`
 * (UI-B Task 11). Intentionally fire-and-forget at the call site; the
 * caller manages the optimistic "cancelling…" state via `cancellingIds`
 * and removes the marker on response. Errors are logged + surfaced via
 * the returned promise so the caller can roll the optimistic flag back.
 */
async function defaultCancel(agentId: string): Promise<void> {
  const res = await fetch(`/api/team/agent/${agentId}/cancel`, {
    method: 'POST',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`cancel failed (${res.status}): ${detail}`);
  }
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

  // Optimistic-cancel marker set: ids that we've POSTed to the cancel
  // endpoint but haven't yet seen a status='killed' SSE for. Cleared
  // from the SSE handler below when the canonical terminal-status
  // event arrives (mirroring `applyStatusChange`'s row removal). A
  // re-seed without a terminal SSE could leave a stale id in this set
  // for the rest of the session; that's bounded by user clicks and
  // never read for any non-rendered row, so it's an acceptable leak.
  const [cancellingIds, setCancellingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // Re-seed when the parent re-fetches (e.g. after a navigation): the
  // initial props become the new authoritative snapshot. Done at render
  // via state-during-render (sanctioned by React's "Storing
  // information from previous renders" guidance — see
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // so we don't trigger a cascading render: React batches the prop-
  // driven setState into the SAME render cycle.
  const [prevInitialLead, setPrevInitialLead] = useState(initialLead);
  const [prevInitialTeammates, setPrevInitialTeammates] =
    useState(initialTeammates);
  if (
    prevInitialLead !== initialLead ||
    prevInitialTeammates !== initialTeammates
  ) {
    setPrevInitialLead(initialLead);
    setPrevInitialTeammates(initialTeammates);
    setState({ lead: initialLead, teammates: [...initialTeammates] });
  }

  useTeamEvents({
    teamId,
    onMessage: (msg) => {
      const ev = readStatusChange(msg);
      if (!ev) return;
      setState((prev) => applyStatusChange(prev, ev));
      // Option B: drop "cancelling" markers from the SSE handler when
      // the canonical terminal status arrives, instead of from a
      // reactive effect that watches `state.teammates` (which lint
      // flagged as a cascading-render risk). `applyStatusChange`
      // removes the teammate row on terminal status; we mirror that
      // here for `cancellingIds` so the two stay in sync. The lead is
      // never removed (it stays visible across terminal states) so we
      // skip cleanup when the lead's id matches.
      if (
        TERMINAL_STATUSES.has(ev.status) &&
        state.lead?.agentId !== ev.agentId
      ) {
        setCancellingIds((prev) => {
          if (!prev.has(ev.agentId)) return prev;
          const next = new Set(prev);
          next.delete(ev.agentId);
          return next;
        });
      }
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

  const handleCancel = useCallback(
    async (agentId: string) => {
      // Mark optimistically so the pill swaps to "cancelling…"
      // immediately. SSE removal of the row clears the marker.
      setCancellingIds((prev) => {
        if (prev.has(agentId)) return prev;
        const next = new Set(prev);
        next.add(agentId);
        return next;
      });
      try {
        if (onStop) {
          // Caller-supplied override (used by tests). Treat as
          // synchronous; if they want async behavior they can return a
          // promise that we still await.
          await Promise.resolve(onStop(agentId));
        } else {
          await defaultCancel(agentId);
        }
      } catch (error: unknown) {
        // Roll the optimistic flag back so the user can retry. The
        // row stays in its current state — SSE will deliver the real
        // truth either way.
        setCancellingIds((prev) => {
          if (!prev.has(agentId)) return prev;
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
        // eslint-disable-next-line no-console
        console.error('[TeammateRoster] cancel failed', error);
      }
    },
    [onStop],
  );

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
            // Lead row never gets a stop button (excluded by isLead +
            // isStoppable check inside RosterRow). We still pass a
            // handler for symmetry but it's unreachable through the UI.
            onStop={
              state.lead.agentId
                ? () => handleCancel(state.lead!.agentId!)
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
              cancelling={cancellingIds.has(t.agentId)}
              onStop={() => handleCancel(t.agentId)}
            />
          ))
        )}
      </div>
    </aside>
  );
}
