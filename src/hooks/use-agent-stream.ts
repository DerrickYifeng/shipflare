'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// v3 agent identifiers emitted by /api/events. v1's 'scout' was remapped
// to 'discovery' when the automation/run route started publishing the
// agent_start event with the new name; v1's 'content-batch' is gone (the
// draft-single-* skills stream under 'content' via monitor.ts /
// plan-execute.ts).
// SSE feed labels for the user-visible activity stream. NOT agent registry
// names — 'review' and 'posting' map to the validating-draft and
// posting-to-platform fork-skills (post-migration 2026-04-30). Kept stable
// to preserve activity-history UI continuity.
type AgentName = 'discovery' | 'content' | 'review' | 'posting';

export interface AgentState {
  status: 'active' | 'complete' | 'idle' | 'error';
  currentTask?: string;
  progress?: number; // 0-100
  stats: Record<string, number | string>;
  cost?: number;
  duration?: number; // seconds
  log: string[];
}

type AgentMap = Record<string, AgentState>;

/** Maximum log entries per agent to prevent unbounded memory growth. */
const MAX_LOG_ENTRIES = 200;

/** Delay in ms before attempting to reconnect after a disconnect. */
const RECONNECT_DELAY_MS = 3_000;

// ---------------------------------------------------------------------------
// Event payload shapes
// ---------------------------------------------------------------------------

interface AgentStartEvent {
  type: 'agent_start';
  agentName: AgentName;
  currentTask?: string;
}

interface AgentProgressEvent {
  type: 'agent_progress';
  agentName: AgentName;
  progress: number;
  currentTask?: string;
}

interface AgentCompleteEvent {
  type: 'agent_complete';
  agentName: AgentName;
  stats?: Record<string, number | string>;
  cost?: number;
  duration?: number;
}

interface ToolCallEvent {
  type: 'tool_call';
  agentName: AgentName;
  toolName: string;
  args?: string;
}

interface DraftReviewedEvent {
  type: 'draft_reviewed';
  agentName: AgentName;
  stats?: Record<string, number | string>;
}

interface ConnectedEvent {
  type: 'connected';
}

interface HeartbeatEvent {
  type: 'heartbeat';
}

type SSEEvent =
  | AgentStartEvent
  | AgentProgressEvent
  | AgentCompleteEvent
  | ToolCallEvent
  | DraftReviewedEvent
  | ConnectedEvent
  | HeartbeatEvent;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createIdleAgent(): AgentState {
  return {
    status: 'idle',
    progress: undefined,
    currentTask: undefined,
    stats: {},
    cost: undefined,
    duration: undefined,
    log: [],
  };
}

function ensureAgent(agents: AgentMap, name: string): AgentState {
  return agents[name] ?? createIdleAgent();
}

/**
 * Immutable reducer that applies a single SSE event to the agents map.
 * Returns a new object reference only when state actually changes.
 */
function applyEvent(agents: AgentMap, event: SSEEvent): AgentMap {
  switch (event.type) {
    case 'agent_start': {
      const prev = ensureAgent(agents, event.agentName);
      return {
        ...agents,
        [event.agentName]: {
          ...prev,
          status: 'active',
          currentTask: event.currentTask ?? prev.currentTask,
          progress: 0,
        },
      };
    }

    case 'agent_progress': {
      const prev = ensureAgent(agents, event.agentName);
      return {
        ...agents,
        [event.agentName]: {
          ...prev,
          status: 'active',
          progress: event.progress,
          currentTask: event.currentTask ?? prev.currentTask,
        },
      };
    }

    case 'agent_complete': {
      const prev = ensureAgent(agents, event.agentName);
      return {
        ...agents,
        [event.agentName]: {
          ...prev,
          status: 'complete',
          progress: 100,
          stats: { ...prev.stats, ...event.stats },
          cost: event.cost ?? prev.cost,
          duration: event.duration ?? prev.duration,
        },
      };
    }

    case 'tool_call': {
      const prev = ensureAgent(agents, event.agentName);
      const entry = `${event.toolName}(${event.args ?? ''})`;
      const log =
        prev.log.length >= MAX_LOG_ENTRIES
          ? [...prev.log.slice(1), entry]
          : [...prev.log, entry];
      return {
        ...agents,
        [event.agentName]: {
          ...prev,
          log,
        },
      };
    }

    case 'draft_reviewed': {
      const prev = ensureAgent(agents, event.agentName);
      return {
        ...agents,
        [event.agentName]: {
          ...prev,
          stats: { ...prev.stats, ...event.stats },
        },
      };
    }

    default:
      return agents;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentStream(): {
  agents: AgentMap;
  isConnected: boolean;
} {
  const [agents, setAgents] = useState<AgentMap>({});
  const [isConnected, setIsConnected] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Holds the latest `connect` so the reconnect timer can call it without
  // creating a temporal-dead-zone self-reference inside the useCallback body
  // (React Compiler flags the direct self-call otherwise).
  const connectRef = useRef<() => void>(() => undefined);

  const connect = useCallback(() => {
    // Prevent connection attempts after unmount
    if (!mountedRef.current) return;

    // Tear down any existing connection before creating a new one
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const es = new EventSource('/api/events');
    eventSourceRef.current = es;

    es.onmessage = (msg: MessageEvent<string>) => {
      if (!mountedRef.current) return;

      let event: SSEEvent;
      try {
        event = JSON.parse(msg.data) as SSEEvent;
      } catch {
        // Malformed payload -- skip silently
        return;
      }

      if (event.type === 'connected') {
        setIsConnected(true);
        return;
      }

      if (event.type === 'heartbeat') {
        return;
      }

      setAgents((prev) => applyEvent(prev, event));
    };

    es.onerror = () => {
      if (!mountedRef.current) return;

      setIsConnected(false);

      // EventSource will attempt its own reconnect in some browsers, but the
      // spec behaviour is inconsistent. Close explicitly and schedule our own
      // reconnect to guarantee predictable timing.
      es.close();
      eventSourceRef.current = null;

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connectRef.current();
      }, RECONNECT_DELAY_MS);
    };
  }, []);

  // Keep the ref pointing at the latest `connect` so the reconnect timer
  // always invokes the current closure.
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;

      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [connect]);

  return { agents, isConnected };
}
