'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentState } from './use-agent-stream';
import { useToast } from '@/components/ui/toast';

type AgentMap = Record<string, AgentState>;

interface AgentStreamContextValue {
  agents: AgentMap;
  isConnected: boolean;
}

const AgentStreamContext = createContext<AgentStreamContextValue>({
  agents: {},
  isConnected: false,
});

export function useAgentStreamContext(): AgentStreamContextValue {
  return useContext(AgentStreamContext);
}

// ---------------------------------------------------------------------------
// Event types (duplicated from use-agent-stream to keep the provider standalone)
// ---------------------------------------------------------------------------

type AgentName = 'scout' | 'discovery' | 'content' | 'review' | 'posting';

type SSEEvent =
  | { type: 'agent_start'; agentName: AgentName; currentTask?: string }
  | { type: 'agent_progress'; agentName: AgentName; progress: number; currentTask?: string }
  | { type: 'agent_complete'; agentName: AgentName; platform?: string; stats?: Record<string, number | string>; cost?: number; duration?: number }
  | { type: 'tool_call'; agentName: AgentName; toolName: string; args?: string }
  | { type: 'draft_reviewed'; agentName: AgentName; draftId?: string; verdict?: string; score?: number; community?: string; stats?: Record<string, number | string> }
  | { type: 'draft_auto_approved'; draftId?: string; verdict?: string; score?: number; community?: string }
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
  const { toast } = useToast();

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
    <AgentStreamContext.Provider value={{ agents, isConnected }}>
      {children}
    </AgentStreamContext.Provider>
  );
}
