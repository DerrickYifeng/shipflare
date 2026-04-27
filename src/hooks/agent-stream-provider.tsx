'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentState } from './use-agent-stream';
import { useToast } from '@/components/ui/toast';

type AgentMap = Record<string, AgentState>;

export interface AgentErrorEntry {
  /** Local id — monotonic per provider instance. */
  id: number;
  /** Wall-clock timestamp in ms. */
  timestamp: number;
  /** Processor / agent that emitted the error (best effort). */
  processor?: string;
  /** Human-readable error message. */
  message: string;
  /** Optional correlation id for log-grep. */
  traceId?: string;
  /** Full raw payload for the drawer — everything the producer sent. */
  payload: Record<string, unknown>;
}

interface AgentStreamContextValue {
  agents: AgentMap;
  isConnected: boolean;
  /** Latest-first list of error events received since this provider mounted. */
  errors: AgentErrorEntry[];
  /** Drop an error from the list (e.g. after the user dismisses it). */
  dismissError: (id: number) => void;
  /** Wipe the whole error list. */
  clearErrors: () => void;
}

const AgentStreamContext = createContext<AgentStreamContextValue>({
  agents: {},
  isConnected: false,
  errors: [],
  dismissError: () => {},
  clearErrors: () => {},
});

export function useAgentStreamContext(): AgentStreamContextValue {
  return useContext(AgentStreamContext);
}

/** Bump every time we push a new error into the list. */
let nextErrorId = 1;

// ---------------------------------------------------------------------------
// Event types (duplicated from use-agent-stream to keep the provider standalone)
// ---------------------------------------------------------------------------

// v3 agent identifiers — duplicated from use-agent-stream to keep the
// provider standalone. 'scout' is retired; discovery is its v3 replacement.
type AgentName = 'discovery' | 'content' | 'review' | 'posting';

type SSEEvent =
  | { type: 'agent_start'; agentName: AgentName; currentTask?: string }
  | { type: 'agent_progress'; agentName: AgentName; progress: number; currentTask?: string }
  | { type: 'agent_complete'; agentName: AgentName; platform?: string; stats?: Record<string, number | string>; cost?: number; duration?: number }
  | { type: 'tool_call'; agentName: AgentName; toolName: string; args?: string }
  | { type: 'draft_reviewed'; agentName: AgentName; draftId?: string; verdict?: string; score?: number; community?: string; stats?: Record<string, number | string> }
  | { type: 'draft_auto_approved'; draftId?: string; verdict?: string; score?: number; community?: string }
  | { type: 'error'; message?: string; error?: string; processor?: string; agentName?: AgentName; traceId?: string }
  | { type: 'stop_requested' }
  | { type: 'connected' }
  | { type: 'heartbeat' };

const MAX_LOG_ENTRIES = 200;
const RECONNECT_DELAY_MS = 3_000;

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
// Provider
// ---------------------------------------------------------------------------

export function AgentStreamProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<AgentMap>({});
  const [isConnected, setIsConnected] = useState(false);
  const [errors, setErrors] = useState<AgentErrorEntry[]>([]);
  const { toast } = useToast();

  const dismissError = useCallback((id: number) => {
    setErrors((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const clearErrors = useCallback(() => {
    setErrors([]);
  }, []);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

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
        return;
      }

      if (event.type === 'connected') {
        setIsConnected(true);
        return;
      }

      if (event.type === 'heartbeat') {
        return;
      }

      if (event.type === 'error') {
        const message = event.message ?? event.error ?? 'Unknown error';
        const entry: AgentErrorEntry = {
          id: nextErrorId++,
          timestamp: Date.now(),
          processor: event.processor ?? event.agentName,
          message,
          traceId: event.traceId,
          payload: event as unknown as Record<string, unknown>,
        };
        setErrors((prev) => [entry, ...prev].slice(0, 50));
        toastRef.current(`Agent error: ${message}`, 'error');
        return;
      }

      // Draft notification toasts
      if (event.type === 'draft_auto_approved') {
        toastRef.current(
          `Draft auto-approved for ${event.community ?? 'thread'} (score: ${event.score ?? '?'})`,
          'info',
        );
        return;
      }

      if (event.type === 'draft_reviewed' && event.verdict) {
        const variant = event.verdict === 'PASS' ? 'success' : event.verdict === 'FAIL' ? 'error' : 'warning';
        toastRef.current(
          `Draft reviewed: ${event.verdict} for ${event.community ?? 'thread'}`,
          variant,
        );
      }

      setAgents((prev) => applyEvent(prev, event));
    };

    es.onerror = () => {
      if (!mountedRef.current) return;

      setIsConnected(false);
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

  return (
    <AgentStreamContext.Provider
      value={{ agents, isConnected, errors, dismissError, clearErrors }}
    >
      {children}
    </AgentStreamContext.Provider>
  );
}
