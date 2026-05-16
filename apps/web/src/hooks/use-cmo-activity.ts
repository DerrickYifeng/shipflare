'use client';

// React hook for the CMO activity feed (Task 11 of spec
// 2026-05-15-agent-activity-feed-design.md).
//
// Subscribes to live activity events emitted by the user's CMO Durable
// Object via a WebSocket opened through the Cloudflare Agents SDK
// (`useAgent`). On mount and on every reconnect, calls
// `GET /api/cmo-activity` to seed the feed with events the client
// missed while disconnected -- the API route proxies through to CMO's
// `getRecentActivity` MCP tool (see follow-up #1 of the activity-feed
// spec). Dedupes by event id (a Set held in a ref so it survives
// re-renders) and filters by `conversationId` OR `runId`.
//
// Auth: the WS handshake is authenticated by a short-lived (60s) JWT
// minted at `/api/cmo-ws-token`. The hook fetches a fresh token on
// userId change and retries with capped exponential backoff on failure
// (max 8s) so a flaky network doesn't permanently break the feed. The
// seed-replay proxy uses the standard Better Auth session cookie -- no
// separate token plumbing.
//
// `useAgent` from `agents/react` rebuilds its WS URL when any entry in
// `queryDeps` changes -- supplying `[token]` therefore reconnects with
// the new token whenever the hook refreshes it. The seed-replay effect
// also depends on `token`, so it re-runs after every reconnect to
// backfill any events that fired while the socket was down.
//
// `isConnected` reflects the *actual* WebSocket state, not just token
// presence: we keep a `wsOpen` boolean driven by `useAgent`'s
// `onOpen`/`onClose`/`onError` callbacks. This lets consumers
// (PlanBuildActivity, indicators, etc.) render a "connecting..." state
// during the handshake or after a transient disconnect.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgent } from 'agents/react';
import {
  ActivityEventSchema,
  type ActivityEvent,
} from '@shipflare/shared';

import { authClient } from '@/auth-client';

export type CmoActivityFilter =
  | { conversationId: string }
  | { runId: string };

export interface UseCmoActivityResult {
  events: ActivityEvent[];
  /**
   * `true` only when BOTH:
   *   - a WS auth token has been successfully fetched, AND
   *   - the underlying WebSocket has fired `open` and has not since
   *     fired `close` / `error`.
   *
   * Consumers can rely on `isConnected === false` to render a
   * "connecting..." indicator during the handshake or after a
   * transient disconnect. The hook auto-reconnects via the Agents
   * SDK; this flag flips back to `true` once the new socket opens.
   */
  isConnected: boolean;
  /**
   * Token-fetch error message, or `null` while the token is healthy.
   * WS-level transport errors are not surfaced here -- the SDK
   * handles them by auto-reconnecting; consumers see them indirectly
   * via `isConnected` flipping to `false`.
   */
  connectionError: string | null;
}

interface TokenResponse {
  token: string;
  // The token endpoint also returns `wsUrl`, but `useAgent` builds its
  // own URL from the `agent` / `name` params -- we only need the token.
  wsUrl?: string;
}

interface SessionLike {
  data?: { user?: { id?: string | null } | null } | null;
}

// Seed-replay goes through the Next.js API route `/api/cmo-activity`
// rather than the Agents SDK stub. The stub only exposes methods
// decorated with `@callable`, and `getRecentActivity` is registered as
// an MCP tool (apps/core/src/agents/cmo/tools/get-recent-activity.ts).
// The proxy route wraps that tool call so we keep MCP as the single
// canonical surface and don't have to duplicate the implementation.

const MAX_BACKOFF_MS = 8_000;

// Bounds for in-memory caches on long-lived sessions.
//
// `seenIds` is the dedupe ledger -- without a cap it grows for the life
// of the tab. Cap to MAX_SEEN_IDS with insertion-order eviction (JS Set
// preserves insertion order, so `.values().next().value` is the oldest).
//
// `events` is the React state array rendered by the activity feed.
// During a sweep-heavy run a single conversation can emit hundreds of
// events; cap to MAX_EVENTS so the rendered list (and the React tree
// memoising it) stays bounded. The slice keeps the most recent N.
const MAX_SEEN_IDS = 5_000;
const MAX_EVENTS = 1_000;

function rememberId(set: Set<string>, id: string): void {
  if (set.has(id)) return;
  if (set.size >= MAX_SEEN_IDS) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(id);
}

function capEvents(list: ActivityEvent[]): ActivityEvent[] {
  return list.length > MAX_EVENTS ? list.slice(-MAX_EVENTS) : list;
}

export function useCmoActivity(
  filter: CmoActivityFilter,
): UseCmoActivityResult {
  // Better Auth client `useSession()` returns `{ data, isPending, error }`.
  // We only need `data.user.id` here; `unknown` cast forces narrowing.
  const session = authClient.useSession() as unknown as SessionLike;
  const userId = session?.data?.user?.id ?? null;

  const [token, setToken] = useState<string | null>(null);
  // Host extracted from the wsUrl returned by /api/cmo-ws-token. The CMO DO
  // lives on the core worker, not the web worker — useAgent must connect to
  // the core origin, not window.location.host.
  const [wsHost, setWsHost] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  // Tracks the underlying WebSocket's open/closed state. The Agents SDK
  // (`useAgent`) returns a PartySocket whose `readyState` getter reports
  // the live state, but reading a getter doesn't trigger React renders.
  // Instead we drive a piece of React state from the `onOpen`/`onClose`/
  // `onError` callbacks so `isConnected` flips reactively on handshake
  // success and transient disconnects.
  const [wsOpen, setWsOpen] = useState<boolean>(false);

  // `useRef` so the seen-id set survives re-renders without being part
  // of state (we don't want re-renders just because we logged an id).
  const seenIds = useRef<Set<string>>(new Set());

  // Stable string key so the seed-replay effect only re-runs when the
  // *contents* of the filter object change, not its reference.
  const filterKey =
    'conversationId' in filter
      ? `conv:${filter.conversationId}`
      : `run:${filter.runId}`;

  // ---------------- 1. Fetch the WS token ----------------------------------
  // POST is what the plan example shows, but the actual route handler is
  // GET (mirrors /api/mcp-token). We use GET to match.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let attempt = 0;
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const fetchToken = async (): Promise<void> => {
      try {
        const res = await fetch('/api/cmo-ws-token', { method: 'GET' });
        if (!res.ok) throw new Error(`token endpoint ${res.status}`);
        const body = (await res.json()) as TokenResponse;
        if (cancelled) return;
        setToken(body.token);
        if (body.wsUrl) {
          try {
            setWsHost(new URL(body.wsUrl).host);
          } catch {
            // Malformed wsUrl — fall back to same-origin
          }
        }
        setTokenError(null);
      } catch (err: unknown) {
        if (cancelled) return;
        const msg =
          err instanceof Error ? err.message : 'token fetch failed';
        setTokenError(msg);
        attempt += 1;
        const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (attempt - 1));
        timerId = setTimeout(() => {
          void fetchToken();
        }, delay);
      }
    };

    void fetchToken();
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [userId]);

  // ---------------- 2. Open the WS via useAgent ----------------------------
  // `useAgent` opens the live WebSocket. Seed-replay rides the HTTP
  // proxy below, not the SDK stub (the SDK stub only exposes @callable
  // methods, and `getRecentActivity` is an MCP tool). The return value
  // isn't used here -- we drop it on the floor and let `queryDeps`
  // handle reconnection.
  useAgent({
    agent: 'cmo',
    name: userId ?? '__skip__',
    // Route the WebSocket to the core worker, not the web worker. The CMO DO
    // lives in apps/core; apps/web has no /agents/* handler. wsHost is null
    // until the token fetch resolves — useAgent skips opening the socket
    // while name is '__skip__' (no userId yet), so the first real connection
    // always uses the correct host.
    host: wsHost ?? undefined,
    // The SDK signature is `() => Promise<QueryObject>` where
    // QueryObject = Record<string, string | null>. We surface `null`
    // when the token isn't ready yet -- the SDK drops null entries so
    // no `?token=` slips through unauthenticated.
    query: async () => ({ token: token ?? null }),
    queryDeps: [token, wsHost],
    onOpen: () => {
      setWsOpen(true);
    },
    onClose: () => {
      setWsOpen(false);
    },
    onError: () => {
      // The SDK will auto-reconnect; flip `isConnected` to false so
      // consumers can show a "reconnecting" indicator in the meantime.
      setWsOpen(false);
    },
    onMessage: (msg: MessageEvent<string>) => {
      let parsed: ActivityEvent;
      try {
        parsed = ActivityEventSchema.parse(JSON.parse(msg.data));
      } catch {
        // Malformed frame -- drop silently. The server never emits these
        // intentionally; production should treat them as alerts but the
        // hook keeps consuming.
        return;
      }
      if (
        'conversationId' in filter &&
        parsed.conversationId !== filter.conversationId
      ) {
        return;
      }
      if ('runId' in filter && parsed.runId !== filter.runId) {
        return;
      }
      if (seenIds.current.has(parsed.id)) return;
      rememberId(seenIds.current, parsed.id);
      setEvents((prev) => capEvents([...prev, parsed]));
    },
  });

  // ---------------- 3. Seed-replay on mount / filter / reconnect -----------
  // Runs once we have a token (so we know the founder is authenticated).
  // Also re-runs whenever the token changes (i.e. after every reconnect),
  // which backfills events that arrived while the socket was down.
  //
  // The proxy at `/api/cmo-activity` verifies the session and calls CMO's
  // `getRecentActivity` MCP tool on the founder's behalf. We don't pass
  // the JWT directly -- the route relies on the same Better Auth session
  // cookie the rest of the web app uses.
  useEffect(() => {
    if (!userId || !token) return;
    let cancelled = false;

    void (async () => {
      const params = new URLSearchParams();
      if ('conversationId' in filter) {
        params.set('conversationId', filter.conversationId);
      }
      if ('runId' in filter) {
        params.set('runId', filter.runId);
      }

      let res: Response;
      try {
        res = await fetch(`/api/cmo-activity?${params.toString()}`);
      } catch {
        // Network error -- silent. Live broadcasts will still arrive
        // over the WS if it connects.
        return;
      }
      if (cancelled || !res.ok) return;

      let body: { events?: unknown } = {};
      try {
        body = (await res.json()) as { events?: unknown };
      } catch {
        return;
      }
      if (cancelled) return;

      // Defensive validation -- the wire shape should match
      // ActivityEvent. Drop any row that fails Zod, so a partial schema
      // change on the server doesn't crash the client.
      const raw = body.events;
      const seed: ActivityEvent[] = Array.isArray(raw)
        ? raw.flatMap((row) => {
            const result = ActivityEventSchema.safeParse(row);
            return result.success ? [result.data] : [];
          })
        : [];

      const fresh = seed.filter((e) => !seenIds.current.has(e.id));
      if (fresh.length === 0) return;
      fresh.forEach((e) => rememberId(seenIds.current, e.id));
      setEvents((prev) =>
        capEvents(
          [...prev, ...fresh].sort((a, b) => a.createdAt - b.createdAt),
        ),
      );
    })();

    return () => {
      cancelled = true;
    };
    // `filter` is referenced inside but its contents are encoded in
    // `filterKey` -- using the stable key avoids re-running on every
    // parent render that constructs a fresh object literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, token, filterKey]);

  return useMemo(
    () => ({
      events,
      // Require a healthy token, a resolved wsHost (core worker URL), AND
      // an open WebSocket. Without wsHost the socket is connecting to the
      // wrong origin and will never receive events.
      isConnected: token !== null && wsHost !== null && tokenError === null && wsOpen,
      connectionError: tokenError,
    }),
    [events, token, wsHost, tokenError, wsOpen],
  );
}
