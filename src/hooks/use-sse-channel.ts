'use client';

import { useEffect, useRef } from 'react';

/**
 * Logical SSE channels exposed by `/api/events?channel=<name>`.
 *
 * Mirrors the server-side `UserEventChannel` union in
 * `src/lib/redis/index.ts`. Duplicated here rather than imported so this
 * client-only module doesn't pull the Redis client into the bundle.
 */
export type SSEChannel = 'agents' | 'drafts' | 'tweets' | 'all';

interface Options {
  /**
   * If false, the hook won't open the connection. Useful for tab / route
   * visibility gating so background routes don't hold an SSE socket open.
   * Default: true.
   */
  enabled?: boolean;
}

/**
 * Open an EventSource on `/api/events?channel=<channel>` and invoke `onEvent`
 * for every non-heartbeat message.
 *
 * The callback is stored in a ref so changing it on every render doesn't
 * tear the connection down and reconnect. Changes to `channel` or `enabled`
 * DO tear down + reconnect.
 *
 * Cleans up on unmount — EventSource + any pending reconnects are cancelled.
 *
 * Intended usage: lightweight cache invalidation. Call `mutate()` from SWR
 * inside `onEvent` and drop `refreshInterval` down to a slow safety-net
 * (60s) so the UI refreshes immediately on real events instead of polling.
 */
export function useSSEChannel(
  channel: SSEChannel,
  onEvent: (data: unknown) => void,
  options: Options = {},
): void {
  const { enabled = true } = options;
  const callbackRef = useRef(onEvent);
  // Keep the ref in sync with the latest callback without mutating during
  // render (React Compiler's immutability rule). This effect has no deps so
  // it runs after every render, matching the prior write-during-render.
  useEffect(() => {
    callbackRef.current = onEvent;
  });

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined') return;

    let cancelled = false;
    const url =
      channel === 'all' ? '/api/events' : `/api/events?channel=${channel}`;
    const es = new EventSource(url);

    es.onmessage = (msg: MessageEvent<string>) => {
      if (cancelled) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.data);
      } catch {
        return;
      }
      // Skip transport-level events that aren't meaningful to consumers.
      if (
        parsed &&
        typeof parsed === 'object' &&
        'type' in parsed &&
        ((parsed as { type: string }).type === 'heartbeat' ||
          (parsed as { type: string }).type === 'connected')
      ) {
        return;
      }
      callbackRef.current(parsed);
    };

    // Let the browser's default EventSource reconnect handle transient
    // disconnects — we don't want duplicate reconnect loops.
    return () => {
      cancelled = true;
      es.close();
    };
  }, [channel, enabled]);
}
