'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TeamMessageType =
  | 'user_prompt'
  | 'agent_text'
  | 'tool_call'
  | 'tool_result'
  | 'completion'
  | 'error'
  | 'thinking';

export interface TeamActivityMessage {
  id: string;
  runId: string | null;
  teamId: string | null;
  from: string | null;
  to: string | null;
  type: TeamMessageType | string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface UseTeamEventsOptions {
  teamId: string;
  runId?: string | null;
  /**
   * Called once per *new* message (deduped by id). The current value of the
   * messages array is already updated by the time this fires.
   */
  onMessage?: (msg: TeamActivityMessage) => void;
  /**
   * Optional predicate — return false to skip appending a message. Useful
   * for scoping to a single team member's activity view.
   */
  filter?: (msg: TeamActivityMessage) => boolean;
  /**
   * Seed the message list (e.g. from a server-rendered initial fetch) so
   * the UI doesn't flicker an empty state before the first SSE snapshot
   * arrives. Dedupe is by id, so backfill races are safe.
   */
  initialMessages?: TeamActivityMessage[];
}

export interface UseTeamEventsResult {
  messages: TeamActivityMessage[];
  isConnected: boolean;
  reconnecting: boolean;
  /** Incremented every time we successfully (re)connect; lets callers pulse UI. */
  connectSeq: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

// ---------------------------------------------------------------------------
// Raw wire payloads
// ---------------------------------------------------------------------------

interface ConnectedPayload {
  type: 'connected';
  teamId: string;
  runId: string | null;
}
interface SnapshotPayload {
  type: 'snapshot';
  messageId: string;
  runId: string | null;
  teamId: string | null;
  from: string | null;
  to: string | null;
  messageType: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
interface SnapshotEndPayload {
  type: 'snapshot_end';
}
interface EventPayload {
  type: 'event';
  messageId?: string;
  runId?: string | null;
  teamId?: string | null;
  from?: string | null;
  to?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  // Underlying team_messages.type (publish payload renames nothing here).
  [key: string]: unknown;
}
interface ReconnectPayload {
  type: 'reconnect';
}

type WirePayload =
  | ConnectedPayload
  | SnapshotPayload
  | SnapshotEndPayload
  | EventPayload
  | ReconnectPayload;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function normalizeSnapshot(p: SnapshotPayload): TeamActivityMessage {
  return {
    id: p.messageId,
    runId: p.runId ?? null,
    teamId: p.teamId ?? null,
    from: p.from ?? null,
    to: p.to ?? null,
    type: p.messageType,
    content: p.content ?? null,
    metadata: p.metadata ?? null,
    createdAt: p.createdAt,
  };
}

function normalizeEvent(p: EventPayload): TeamActivityMessage | null {
  const id = typeof p.messageId === 'string' ? p.messageId : null;
  if (!id) return null;
  const innerType = p.type;
  // The `type` field we see on the wire here is the wrapper ('event'); the
  // real team_messages type lives on `p.type` of the inner publish payload,
  // which `/api/team/events` spreads with `...parsed`, so the wire value of
  // `type` is actually the *publish* type. Guard against the wrapper slipping
  // through when we inspect it below.
  const messageType =
    typeof innerType === 'string' && innerType !== 'event'
      ? innerType
      : 'agent_text';
  return {
    id,
    runId: typeof p.runId === 'string' ? p.runId : null,
    teamId: typeof p.teamId === 'string' ? p.teamId : null,
    from: typeof p.from === 'string' ? p.from : null,
    to: typeof p.to === 'string' ? p.to : null,
    type: messageType,
    content: typeof p.content === 'string' ? p.content : null,
    metadata: isRecord(p.metadata) ? (p.metadata as Record<string, unknown>) : null,
    createdAt:
      typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribe to `/api/team/events` as a typed stream of `team_messages`.
 *
 * Maintains a chronologically-ordered, id-deduped message list; caller
 * decides how to render it. Reconnects with exponential backoff on
 * dropped connections and on the server-emitted `reconnect` event
 * (which fires when the SSE route's 30-minute max-age expires).
 */
export function useTeamEvents({
  teamId,
  runId,
  onMessage,
  filter,
  initialMessages,
}: UseTeamEventsOptions): UseTeamEventsResult {
  const [messages, setMessages] = useState<TeamActivityMessage[]>(
    () => initialMessages ?? [],
  );
  const [isConnected, setIsConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [connectSeq, setConnectSeq] = useState(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const mountedRef = useRef(true);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const connectRef = useRef<() => void>(() => undefined);
  const onMessageRef = useRef(onMessage);
  const filterRef = useRef(filter);

  // Keep the latest callbacks accessible inside the EventSource handler
  // without invalidating the `connect` closure (which would force a
  // reconnect on every render).
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  // Seed `seenIdsRef` with the initial set of messages so re-entry of those
  // ids (from a snapshot) doesn't double-append. Only runs once per mount.
  useEffect(() => {
    if (initialMessages) {
      for (const m of initialMessages) seenIdsRef.current.add(m.id);
    }
    // Intentionally one-shot: we don't re-seed if `initialMessages` identity
    // changes; new data comes via the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const appendMessage = useCallback((msg: TeamActivityMessage) => {
    if (seenIdsRef.current.has(msg.id)) return;
    const f = filterRef.current;
    if (f && !f(msg)) {
      // Still mark as seen so a later snapshot doesn't re-push it.
      seenIdsRef.current.add(msg.id);
      return;
    }
    seenIdsRef.current.add(msg.id);
    setMessages((prev) => {
      // Insert sorted by createdAt (ascending). In the common case the new
      // message is simply the latest, so we append without a full sort.
      if (prev.length === 0 || prev[prev.length - 1].createdAt <= msg.createdAt) {
        return [...prev, msg];
      }
      const next = [...prev, msg];
      next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return next;
    });
    onMessageRef.current?.(msg);
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (!teamId) return;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const qs = new URLSearchParams({ teamId });
    if (runId) qs.set('runId', runId);
    const url = `/api/team/events?${qs.toString()}`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    setReconnecting(true);

    es.onmessage = (evt: MessageEvent<string>) => {
      if (!mountedRef.current) return;
      let payload: WirePayload;
      try {
        payload = JSON.parse(evt.data) as WirePayload;
      } catch {
        return;
      }

      switch (payload.type) {
        case 'connected': {
          setIsConnected(true);
          setReconnecting(false);
          backoffRef.current = INITIAL_BACKOFF_MS;
          setConnectSeq((n) => n + 1);
          return;
        }
        case 'snapshot': {
          appendMessage(normalizeSnapshot(payload));
          return;
        }
        case 'snapshot_end': {
          // No-op for now; callers that care can derive from `connectSeq`
          // ticking after the snapshot is fully drained.
          return;
        }
        case 'reconnect': {
          // Server asked us to cycle the connection (30-min TTL).
          es.close();
          eventSourceRef.current = null;
          setIsConnected(false);
          scheduleReconnect();
          return;
        }
        case 'event': {
          const normalized = normalizeEvent(payload);
          if (normalized) appendMessage(normalized);
          return;
        }
        default:
          return;
      }
    };

    es.onerror = () => {
      if (!mountedRef.current) return;
      setIsConnected(false);
      es.close();
      eventSourceRef.current = null;
      scheduleReconnect();
    };

    function scheduleReconnect(): void {
      if (!mountedRef.current) return;
      setReconnecting(true);
      const base = backoffRef.current;
      backoffRef.current = Math.min(base * 2, MAX_BACKOFF_MS);
      // Add ±25% jitter so many simultaneously-disconnected clients (e.g.
      // after a deploy that bounces the SSE process) don't retry in a
      // synchronized thundering herd.
      const jitter = base * (Math.random() * 0.5 - 0.25);
      const delay = Math.max(250, Math.floor(base + jitter));
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
      }
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connectRef.current();
      }, delay);
    }
  }, [teamId, runId, appendMessage]);

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

  return { messages, isConnected, reconnecting, connectSeq };
}
