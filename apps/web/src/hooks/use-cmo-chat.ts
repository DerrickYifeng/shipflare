'use client';

// Primary chat hook for the founder-facing CMO surface (Phase 8 of the
// CF-native chat migration). Replaces the legacy poll-based chat UI with
// an AIChatAgent WebSocket transport backed by the CMO Durable Object.
//
// Auth: the WS handshake is authenticated by a short-lived (60s) JWT
// minted at `/api/agent-token`. The SDK's `query` option injects it as
// a `?token=` query-string parameter on the WebSocket URL. Browsers
// can't set custom headers on `new WebSocket()`, so query-string is the
// only option — the 60s TTL bounds exposure from proxy / referer logs.
//
// Re-fetches: the SDK re-calls `query` (and rebuilds the WS URL) when
// `queryDeps` changes. Supplying `[userId]` ensures a fresh token is
// fetched whenever the authenticated user changes.
//
// `useAgentToolEvents` captures nested agent-run timelines emitted by
// the CMO's `consult` tool (sub-agent orchestration), keyed by both
// run id and tool-call id for flexible UI rendering.

import { useAgentChat } from '@cloudflare/ai-chat/react';
import { useAgent, useAgentToolEvents } from 'agents/react';

async function fetchAgentJwt(agent: string, name?: string): Promise<string> {
  // SSR guard: useAgent's `query` callback runs via React 19's `use()` which
  // SUSPENDS during SSR — meaning the promise is awaited server-side. A
  // relative-URL `fetch('/api/agent-token?...')` throws "Invalid URL" with
  // no base, crashing the page render. Returning an empty token during SSR
  // lets the page render; the client will re-fetch on mount (queryDeps
  // changes trigger a refresh, but even without that the WS connect kicks
  // a retry once `typeof window !== 'undefined'`).
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams({ agent });
  if (name) params.set('name', name);
  const res = await fetch(`/api/agent-token?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch agent token: ${res.status}`);
  }
  const { token } = (await res.json()) as { token: string };
  return token;
}

export interface UseCmoChatResult {
  messages: ReturnType<typeof useAgentChat>['messages'];
  sendMessage: ReturnType<typeof useAgentChat>['sendMessage'];
  /** True while either a client-initiated or server-initiated stream is active. */
  isStreaming: ReturnType<typeof useAgentChat>['isStreaming'];
  stop: ReturnType<typeof useAgentChat>['stop'];
  agentRuns: Record<string, unknown>;
  agentRunsByToolCall: Record<string, unknown[]>;
}

/**
 * `useCmoChat` — primary chat hook for the founder-facing CMO surface.
 *
 * Built on `@cloudflare/ai-chat/react`'s `useAgentChat` (DO transport +
 * UIMessage state) + `agents/react`'s `useAgentToolEvents` (nested
 * agent-run timeline for the `consult` tool).
 *
 * The hook handles the JWT dance via `query` (query-string params for the
 * WS handshake). Re-fetches the token when `userId` changes.
 *
 * `coreHost` is the bare host (no scheme) of apps/core, e.g.
 * `mcp-staging.shipflare.ai` or `localhost:3001`. The parent page must
 * derive it from `env.CORE_PUBLIC_URL` server-side and pass it in — the
 * client bundle has no env access. When omitted, `useAgent` falls back to
 * `window.location.host`, which is wrong on the custom-domain split
 * (apps/web on app-*.shipflare.ai, apps/core on mcp-*.shipflare.ai).
 */
export function useCmoChat({
  userId,
  conversationId,
  coreHost,
}: {
  userId: string;
  conversationId?: string;
  coreHost?: string;
}): UseCmoChatResult {
  // The browser knows its own timezone via Intl; we ship it on the WS
  // handshake so the CMO DO can bootstrap `founder_context.tz` on first
  // connect (server-side fallback is `request.cf.timezone`, then `UTC`).
  // Resolved at hook-call time — Intl is stable per session so this is
  // safe to read synchronously and capture into the async `query`.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const agent = useAgent({
    agent: 'cmo',
    name: userId,
    // Cross-origin WS target. Without `host`, useAgent defaults to
    // `window.location.host` — broken when apps/web and apps/core live
    // on different subdomains (Phase 11 custom-domain migration).
    host: coreHost,
    // The SDK's QueryObject is Record<string, string | null>. We return the
    // token alongside the inferred timezone so `useAgent` appends
    // `?token=<jwt>&tz=<IANA>` to the WS URL. The server reads `tz` in
    // `handleCmoWsRequest` and forwards it via `x-inferred-tz` header.
    query: async () => ({
      token: await fetchAgentJwt('cmo', userId),
      tz,
    }),
    queryDeps: [userId, tz],
  });

  const chat = useAgentChat({ agent, id: conversationId });
  const { runsById, runsByToolCallId } = useAgentToolEvents({ agent });

  return {
    messages: chat.messages,
    sendMessage: chat.sendMessage,
    isStreaming: chat.isStreaming,
    stop: chat.stop,
    agentRuns: runsById,
    agentRunsByToolCall: runsByToolCallId,
  };
}
