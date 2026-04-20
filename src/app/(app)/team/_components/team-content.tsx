'use client';

/**
 * Client shell for `/team`. Owns all live state for the isometric office
 * scene: subscribes to the shared `AgentStreamProvider`, derives per-agent
 * scene statuses, keeps a small rolling log for the ticker, and handles
 * pause/resume + selection.
 *
 * Data flow:
 *   AgentStreamProvider (SSE /api/events)
 *     → useAgentStreamContext → { agents, isConnected, errors }
 *     → derive Record<AgentId, AgentPanelState>
 *     → OfficeScene + AgentSidebarPanel + AgentDetailPanel
 *
 * Handoff / walk animation:
 *   We don't yet emit server-side handoff events, so the walk animation is
 *   driven client-side by `agent_complete → next-agent_start` transitions we
 *   observe in the stream. Until a dedicated SSE handoff contract lands
 *   (DATA_CONTRACT.md §2.3), `walkingAgentId` stays null and every character
 *   renders at their desk — honest rather than ceremonial.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { HeaderBar } from '@/components/layout/header-bar';
import { Button } from '@/components/ui/button';
import { useAgentStreamContext } from '@/hooks/agent-stream-provider';
import type { AgentState as StreamAgentState } from '@/hooks/use-agent-stream';

import { OfficeScene } from './office-scene';
import { AgentSidebarPanel, type AgentPanelState } from './agent-sidebar-panel';
import { AgentDetailPanel } from './agent-detail-panel';
import { HistoryTicker, type TickerEvent } from './history-ticker';
import {
  AGENT_ROSTER,
  sceneStatusFor,
  type AgentEntry,
  type AgentId,
  type SceneStatus,
} from './agent-roster';

type RunState = 'idle' | 'launching' | 'running' | 'error';

const MAX_TICKER_EVENTS = 20;

export function TeamContent() {
  const { agents, isConnected } = useAgentStreamContext();

  // Build per-agent panel state from the shared stream.
  const panelStates = useMemo(
    () => buildPanelStates(agents),
    [agents],
  );

  // Scene-facing statuses (the OfficeScene cares about these, not the full panel state).
  const sceneStatuses = useMemo(
    () => extractSceneStatuses(panelStates),
    [panelStates],
  );

  // Selection + drawer open state.
  const [selectedId, setSelectedId] = useState<AgentId | null>(null);
  const selectedAgent = useMemo<AgentEntry | null>(
    () => AGENT_ROSTER.find((a) => a.id === selectedId) ?? null,
    [selectedId],
  );
  const selectedState = selectedId ? panelStates[selectedId] : null;

  // Escape closes the drawer.
  useEffect(() => {
    if (selectedId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  // Ticker — we prepend whenever an agent_complete or draft_reviewed event
  // resolves. The easiest way to observe that without reworking the provider
  // is to watch snapshot transitions.
  const tickerEvents = useTickerFromAgents(agents);

  // Pause / resume → maps to /api/automation/{run,stop}.
  const [runState, setRunState] = useState<RunState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const hasActiveAgent = Object.values(agents).some(
    (a) => a?.status === 'active',
  );
  const paused = !hasActiveAgent && runState !== 'launching';

  const handleStart = useCallback(async () => {
    setRunState('launching');
    setErrorMsg(null);
    try {
      const res = await fetch('/api/automation/run', { method: 'POST' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setErrorMsg(payload.error ?? 'Failed to start automation');
        setRunState('error');
        return;
      }
      setRunState('running');
    } catch {
      setErrorMsg('Network error — could not reach server');
      setRunState('error');
    }
  }, []);

  const handleStop = useCallback(async () => {
    try {
      const res = await fetch('/api/automation/stop', { method: 'POST' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        setErrorMsg(payload.error ?? 'Failed to stop automation');
      }
    } catch {
      setErrorMsg('Network error — could not reach server');
    }
  }, []);

  const totalCount = AGENT_ROSTER.length;
  const activeCount = Object.values(sceneStatuses).filter(
    (s) => s !== 'idle' && s !== 'blocked',
  ).length;
  const queueDepth = Object.values(agents).filter(
    (a) => a?.status === 'active',
  ).length;

  const selectedRecentLog = selectedAgent
    ? agents[selectedAgent.streamKey]?.log ?? []
    : [];

  const metaLine = `${totalCount} agents · ${queueDepth} job${queueDepth === 1 ? '' : 's'} in flight`;

  return (
    <>
      <HeaderBar
        title="Your AI Team"
        meta={metaLine}
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {hasActiveAgent ? (
              <Button variant="ghost" size="sm" onClick={handleStop}>
                Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={handleStart}
                disabled={runState === 'launching'}
              >
                {runState === 'launching' ? 'Starting…' : 'Run pipeline'}
              </Button>
            )}
          </div>
        }
      />

      <div style={PAGE_PADDING_STYLE}>
        <div style={TICKER_ROW_STYLE}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <HistoryTicker events={tickerEvents} />
          </div>
        </div>

        {errorMsg && <ErrorBanner message={errorMsg} onDismiss={() => setErrorMsg(null)} />}

        <div style={SCENE_GRID_STYLE}>
          <div style={{ position: 'relative', minWidth: 0 }}>
            <OfficeScene
              statuses={sceneStatuses}
              selectedId={selectedId}
              onSelectAgent={setSelectedId}
              paused={paused}
              walkingAgentId={null}
              walkData={null}
              activeCount={activeCount}
            />
            <AgentDetailPanel
              agent={selectedAgent}
              state={selectedState}
              history={[]}
              recentLog={selectedRecentLog}
              onClose={() => setSelectedId(null)}
            />
          </div>
          <AgentSidebarPanel
            states={panelStates}
            selectedId={selectedId}
            onSelect={setSelectedId}
            isConnected={isConnected}
            queueDepth={queueDepth}
          />
        </div>

        <p style={HINT_STYLE}>
          Tap an agent to see what they are working on. Real-time state streams
          from the worker queue; handoffs and tool calls update live.
        </p>
      </div>
    </>
  );
}

/* -----------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------*/

function buildPanelStates(
  agents: Record<string, StreamAgentState>,
): Record<AgentId, AgentPanelState> {
  const out = {} as Record<AgentId, AgentPanelState>;
  for (const agent of AGENT_ROSTER) {
    out[agent.id] = panelStateFor(agent, agents[agent.streamKey]);
  }
  return out;
}

function panelStateFor(
  agent: AgentEntry,
  streamState: StreamAgentState | undefined,
): AgentPanelState {
  const status = sceneStatusFor(agent.id, streamState?.status);
  const task = streamState?.currentTask?.trim()
    ? streamState.currentTask
    : status === 'idle'
      ? agent.tagline
      : status === 'blocked'
        ? 'Blocked — needs your attention.'
        : agent.tagline;

  const progress01 =
    typeof streamState?.progress === 'number'
      ? Math.max(0, Math.min(1, streamState.progress / 100))
      : 0;

  const stats = deriveStats(streamState);

  return {
    status,
    task,
    progress: progress01,
    stats: stats.length > 0 ? stats : undefined,
    cost: streamState?.cost,
    elapsed: streamState?.duration,
  };
}

function deriveStats(streamState: StreamAgentState | undefined): { label: string; value: ReactNode }[] {
  if (!streamState) return [];
  const entries = Object.entries(streamState.stats).slice(0, 2);
  return entries.map(([key, value]) => ({
    label: key.replace(/_/g, ' '),
    value: String(value),
  }));
}

function extractSceneStatuses(
  panelStates: Record<AgentId, AgentPanelState>,
): Record<AgentId, SceneStatus> {
  const out = {} as Record<AgentId, SceneStatus>;
  for (const agent of AGENT_ROSTER) {
    out[agent.id] = panelStates[agent.id].status;
  }
  return out;
}

type StreamStatus = StreamAgentState['status'];
type StatusSnapshot = Record<string, StreamStatus | undefined>;

interface TickerEntries {
  events: TickerEvent[];
  snapshot: StatusSnapshot;
}

/** Pure diff — given the prior snapshot and the latest stream, emit any new rows. */
function diffTickerEntries(
  prior: StatusSnapshot,
  agents: Record<string, StreamAgentState>,
): TickerEntries {
  const newEvents: TickerEvent[] = [];
  const snapshot: StatusSnapshot = {};
  for (const agent of AGENT_ROSTER) {
    const stream = agents[agent.streamKey];
    const now = stream?.status;
    snapshot[agent.streamKey] = now;
    const prev = prior[agent.streamKey];
    if (!now || now === prev) continue;
    const action =
      now === 'active'
        ? `started ${agent.role.toLowerCase()} — ${stream?.currentTask ?? 'new work'}`
        : now === 'complete'
          ? `finished ${agent.role.toLowerCase()} pass`
          : now === 'error'
            ? 'hit an error — needs attention'
            : null;
    if (action) {
      newEvents.push({ when: formatClock(new Date()), agent: agent.name, action });
    }
  }
  return { events: newEvents, snapshot };
}

interface TickerState {
  events: TickerEvent[];
  snapshot: StatusSnapshot;
}

type TickerAction =
  | { type: 'observe'; agents: Record<string, StreamAgentState> };

const INITIAL_TICKER: TickerState = { events: [], snapshot: {} };

function tickerReducer(state: TickerState, action: TickerAction): TickerState {
  if (action.type !== 'observe') return state;
  const diff = diffTickerEntries(state.snapshot, action.agents);
  if (diff.events.length === 0 && sameSnapshot(state.snapshot, diff.snapshot)) {
    return state;
  }
  const nextEvents =
    diff.events.length > 0
      ? [...diff.events.reverse(), ...state.events].slice(0, MAX_TICKER_EVENTS)
      : state.events;
  return { events: nextEvents, snapshot: diff.snapshot };
}

function sameSnapshot(a: StatusSnapshot, b: StatusSnapshot): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Build a rolling "LIVE LOG" feed from the stream. The reducer pattern
 * keeps the lint-flagged setState-in-effect cascade at bay: we dispatch
 * observations as events, and the reducer decides whether anything
 * actually changed.
 */
function useTickerFromAgents(agents: Record<string, StreamAgentState>): TickerEvent[] {
  const [{ events }, dispatch] = useReducer(tickerReducer, INITIAL_TICKER);
  useEffect(() => {
    dispatch({ type: 'observe', agents });
  }, [agents]);
  return events;
}

function formatClock(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

interface ErrorBannerProps {
  message: string;
  onDismiss: () => void;
}

function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      style={{
        padding: '10px 14px',
        borderRadius: 'var(--sf-radius-md)',
        background: 'oklch(96% 0.02 25 / 0.6)',
        border: '1px solid var(--sf-danger)',
        color: 'var(--sf-danger-ink)',
        fontSize: 'var(--sf-text-sm)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 16,
      }}
    >
      <span style={{ flex: 1 }}>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss error"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--sf-danger-ink)',
          fontSize: 16,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}

/* -----------------------------------------------------------------
 * Layout tokens
 * ----------------------------------------------------------------*/

const PAGE_PADDING_STYLE: CSSProperties = {
  padding: '0 clamp(16px, 3vw, 32px) 40px',
  width: '100%',
};

const TICKER_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  marginBottom: 16,
};

const SCENE_GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 340px)',
  gap: 20,
  alignItems: 'start',
  marginBottom: 16,
};

const HINT_STYLE: CSSProperties = {
  margin: '14px 0 0',
  fontSize: 'var(--sf-text-xs)',
  color: 'var(--sf-fg-3)',
  letterSpacing: 'var(--sf-track-normal)',
};
