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
  | 'thinking'
  /**
   * Ephemeral streaming markers — never hit the DB, only flow through
   * the SSE live feed. The hook turns them into a running
   * `partialMessages` map that the reducer renders as streaming lead
   * bubbles until the matching final `agent_text` arrives.
   */
  | 'agent_text_start'
  | 'agent_text_delta'
  | 'agent_text_stop'
  /**
   * Partial tool-input JSON, keyed by toolUseId. Accumulates into
   * `toolInputPartials` until the durable `tool_call` row lands. Lets
   * dispatch cards show a loading spinner while the LLM is writing out
   * the subagent prompt.
   */
  | 'tool_input_delta';

export interface TeamActivityMessage {
  id: string;
  runId: string | null;
  /** The conversation this message belongs to. Required for the
   *  ChatGPT-style thread filter — the UI only renders messages whose
   *  conversationId matches the focused conversation. */
  conversationId: string | null;
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
  /**
   * Fired when a partial streaming message has been idle for longer than
   * `STALL_TIMEOUT_MS` — the hook has just dropped it from `partials`.
   * Callers typically surface a toast so the user knows the UI isn't
   * silently stuck (the server may still finish via snapshot backfill
   * on the next SSE reconnect, so this is a warning, not a failure).
   */
  onStall?: (messageId: string) => void;
}

/**
 * Partial text a lead message is still streaming — one entry per
 * in-flight `messageId`. The hook drops the entry as soon as the
 * matching final `agent_text` arrives, so the map is always "only
 * what's currently mid-stream".
 */
export interface PartialLeadMessage {
  id: string;
  runId: string | null;
  teamId: string | null;
  from: string | null;
  to: string | null;
  content: string;
  createdAt: string;
  /**
   * Wall-clock timestamp (ms since epoch) of the most recent delta. The
   * stall-detection pass compares `Date.now() - lastActivityAt` against
   * `STALL_TIMEOUT_MS` to decide whether to drop a partial that the
   * worker has stopped feeding. A renderer that wants to show a
   * "thinking deeply…" notice can diff the same field.
   */
  lastActivityAt: number;
}

export interface UseTeamEventsResult {
  messages: TeamActivityMessage[];
  /** In-flight streaming assistant text, keyed by messageId. */
  partials: ReadonlyMap<string, PartialLeadMessage>;
  /**
   * In-flight tool_use input JSON keyed by toolUseId. Each entry is the
   * raw `partial_json` concatenation we've received so far — callers try
   * a tolerant parse and fall back to a loading spinner on failure.
   * Cleared as soon as the matching `tool_call` lands.
   */
  toolInputPartials: ReadonlyMap<string, string>;
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

// Borrowed from Claude Code's `STREAM_IDLE_TIMEOUT_MS` (engine/services/
// api/claude.ts:1912) — a partial bubble that hasn't received a delta in
// this long gets dropped so the breathing indicator doesn't hang forever.
// 30s is long enough to survive slow tool calls without nagging the user
// for momentary Anthropic hiccups.
const STALL_TIMEOUT_MS = 30_000;
const STALL_CHECK_INTERVAL_MS = 5_000;

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
  conversationId?: string | null;
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
  /**
   * Underlying team_messages.type ('user_prompt' | 'agent_text' | ...). The
   * SSE endpoint renames the publish payload's `type` to `messageType` so
   * the wire wrapper `type: 'event'` survives object spread.
   */
  messageType?: string;
  messageId?: string;
  runId?: string | null;
  conversationId?: string | null;
  teamId?: string | null;
  from?: string | null;
  to?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
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
    conversationId: p.conversationId ?? null,
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
  // Read the underlying team_messages.type from `messageType`. Default to
  // 'agent_text' when the sender forgot to include one (legacy rows).
  const messageType =
    typeof p.messageType === 'string' ? p.messageType : 'agent_text';
  return {
    id,
    runId: typeof p.runId === 'string' ? p.runId : null,
    conversationId:
      typeof p.conversationId === 'string' ? p.conversationId : null,
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
  onStall,
}: UseTeamEventsOptions): UseTeamEventsResult {
  const [messages, setMessages] = useState<TeamActivityMessage[]>(
    () => initialMessages ?? [],
  );
  const [partials, setPartials] = useState<ReadonlyMap<string, PartialLeadMessage>>(
    () => new Map(),
  );
  const [toolInputPartials, setToolInputPartials] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const [isConnected, setIsConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [connectSeq, setConnectSeq] = useState(0);
  const onStallRef = useRef<((messageId: string) => void) | undefined>(undefined);

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
  useEffect(() => {
    onStallRef.current = onStall;
  }, [onStall]);

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

  // Delta application is intentionally eager: every `agent_text_delta`
  // calls `setPartials` straight away. React 18's concurrent scheduler
  // provides the backpressure we need — callers wrap `partials` in
  // `useDeferredValue` (see team-desk.tsx) so the render thread yields
  // to the stream consumer when deltas pile up, and catches up when
  // they slow down. Hand-written RAF batching used to live here; it
  // was redundant once `useDeferredValue` went in, and it swallowed
  // the mid-stream state the unit tests assert on.

  const appendMessage = useCallback((msg: TeamActivityMessage) => {
    // Streaming deltas never live in `messages` — they run through the
    // `partials` map, keyed by messageId. We also intentionally DON'T add
    // start/delta/stop ids to `seenIdsRef`, otherwise a re-delivery of
    // the same messageId for the final `agent_text` would be dropped.
    if (msg.type === 'agent_text_start') {
      setPartials((prev) => {
        if (prev.has(msg.id)) return prev;
        const next = new Map(prev);
        next.set(msg.id, {
          id: msg.id,
          runId: msg.runId,
          teamId: msg.teamId,
          from: msg.from,
          to: msg.to,
          content: '',
          createdAt: msg.createdAt,
          lastActivityAt: Date.now(),
        });
        return next;
      });
      return;
    }
    if (msg.type === 'agent_text_delta') {
      setPartials((prev) => {
        const existing = prev.get(msg.id);
        const base: PartialLeadMessage = existing ?? {
          id: msg.id,
          runId: msg.runId,
          teamId: msg.teamId,
          from: msg.from,
          to: msg.to,
          content: '',
          createdAt: msg.createdAt,
          lastActivityAt: Date.now(),
        };
        const next = new Map(prev);
        next.set(msg.id, {
          ...base,
          content: base.content + (msg.content ?? ''),
          lastActivityAt: Date.now(),
        });
        return next;
      });
      return;
    }
    if (msg.type === 'agent_text_stop') {
      // Empty block — worker couldn't produce text for this content_block_stop.
      // Drop the partial so the UI clears the breathing indicator.
      setPartials((prev) => {
        if (!prev.has(msg.id)) return prev;
        const next = new Map(prev);
        next.delete(msg.id);
        return next;
      });
      return;
    }
    if (msg.type === 'tool_input_delta') {
      // messageId carries the toolUseId; content is the partial_json
      // fragment. Append and keep — caller renders a spinner until the
      // full JSON parses or the final tool_call row arrives.
      setToolInputPartials((prev) => {
        const existing = prev.get(msg.id) ?? '';
        const next = new Map(prev);
        next.set(msg.id, existing + (msg.content ?? ''));
        return next;
      });
      return;
    }

    if (seenIdsRef.current.has(msg.id)) return;
    const f = filterRef.current;
    if (f && !f(msg)) {
      // Still mark as seen so a later snapshot doesn't re-push it.
      seenIdsRef.current.add(msg.id);
      return;
    }
    seenIdsRef.current.add(msg.id);

    // Final `agent_text` for a streaming block: remove the matching
    // partial so renderers only see one bubble. Covers both
    // mid-turn narration blocks and the final end_turn text.
    if (msg.type === 'agent_text') {
      setPartials((prev) => {
        if (!prev.has(msg.id)) return prev;
        const next = new Map(prev);
        next.delete(msg.id);
        return next;
      });
    }

    // Durable tool_call arrives → clear the matching partial JSON so
    // the dispatch card flips from spinner to real description. The
    // worker stamps `toolUseId` in camelCase (see emitToolEvent).
    if (msg.type === 'tool_call' && msg.metadata) {
      const meta = msg.metadata as Record<string, unknown>;
      const toolUseId =
        (typeof meta['toolUseId'] === 'string' && meta['toolUseId']) ||
        (typeof meta['tool_use_id'] === 'string' && meta['tool_use_id']);
      if (toolUseId && typeof toolUseId === 'string') {
        setToolInputPartials((prev) => {
          if (!prev.has(toolUseId)) return prev;
          const next = new Map(prev);
          next.delete(toolUseId);
          return next;
        });
      }
    }

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
          // Stream deltas are ephemeral; a mid-stream disconnect means we
          // likely missed the `agent_text_stop` for any in-flight partial.
          // Clear the map so stale breathing indicators don't linger —
          // the final `agent_text` will arrive via snapshot backfill if
          // the stream actually completed on the server side.
          setPartials((prev) => (prev.size === 0 ? prev : new Map()));
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

  // Stall sweeper: drop partials that haven't seen a delta in
  // `STALL_TIMEOUT_MS`. Guards against the Redis → SSE pipe silently
  // going dark mid-stream without the EventSource noticing (happens
  // occasionally on Next.js dev HMR restarts + worker process cycles).
  // The dropped messageId is surfaced via `onStall` so callers can
  // toast — the durable `agent_text` row, if the server eventually
  // wrote one, still backfills through the next snapshot.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!mountedRef.current) return;
      const now = Date.now();
      const stalled: string[] = [];
      setPartials((prev) => {
        if (prev.size === 0) return prev;
        let next: Map<string, PartialLeadMessage> | null = null;
        for (const [id, p] of prev) {
          if (now - p.lastActivityAt > STALL_TIMEOUT_MS) {
            if (!next) next = new Map(prev);
            next.delete(id);
            stalled.push(id);
          }
        }
        return next ?? prev;
      });
      for (const id of stalled) onStallRef.current?.(id);
    }, STALL_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return {
    messages,
    partials,
    toolInputPartials,
    isConnected,
    reconnecting,
    connectSeq,
  };
}
