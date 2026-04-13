'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentName = 'scout' | 'discovery' | 'content' | 'review' | 'posting';

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
        connect();
      }, RECONNECT_DELAY_MS);
    };
  }, []);

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
