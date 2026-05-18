/**
 * useCmoAgent — single WebSocket to a founder's CMO DO.
 *
 * Owns the `useAgent` call. Both `useCmoChat` and `useCmoStub` take the
 * returned `agent` as input — this guarantees one WS per page tree
 * regardless of how many hooks consume it. (The agents SDK does NOT
 * de-dupe `useAgent` calls; each call opens its own socket.)
 *
 * Returns `{ agent, ready, error }`. `error` is non-null when the WS
 * has errored OR closed; cleared on the next successful identification.
 *
 * Auth: JWT from /api/agent-token?agent=cmo (60s TTL); re-fetched when
 * `userId` changes via queryDeps.
 */

"use client";

import { useEffect, useState } from "react";
import { useAgent } from "agents/react";

async function fetchAgentJwt(agent: string, name?: string): Promise<string> {
  // SSR guard — useAgent's `query` callback runs via React 19's `use()`
  // which may run server-side via Suspense. Relative-URL fetch throws
  // "Invalid URL" with no base, crashing the page render. Mirror
  // use-cmo-chat.ts's pattern: empty token server-side; client re-fetches.
  if (typeof window === "undefined") return "";
  const url = name
    ? `/api/agent-token?agent=${agent}&name=${encodeURIComponent(name)}`
    : `/api/agent-token?agent=${agent}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch agent JWT: ${res.status} ${res.statusText}`,
    );
  }
  const json = (await res.json()) as { token: string };
  return json.token;
}

// Capture the runtime return type of `useAgent({...})` without a
// generic arg. TypeScript resolves `ReturnType<typeof useAgent>` to
// the typed overload by default (with `State = never`), whose `call`
// signature conflicts with the untyped one we actually get at runtime.
// Inferring via a wrapper that invokes the hook with a sample options
// object selects the first (untyped) overload — same as our actual
// call site below.
declare const _cmoAgentSample: ReturnType<
  () => ReturnType<typeof useAgent<unknown>>
>;
export type CmoAgent = typeof _cmoAgentSample;

export interface UseCmoAgentResult {
  agent: CmoAgent;
  ready: Promise<void>;
  error: string | null;
}

export function useCmoAgent({
  userId,
  coreHost,
}: {
  userId: string;
  coreHost?: string;
}): UseCmoAgentResult {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const agent = useAgent({
    agent: "cmo",
    name: userId,
    host: coreHost,
    query: async () => ({
      token: await fetchAgentJwt("cmo", userId),
      tz,
    }),
    queryDeps: [userId, tz],
  });

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onErr = (ev: Event) => {
      setError(ev instanceof ErrorEvent ? ev.message : "WebSocket error");
    };
    const onClose = () => {
      setError("WebSocket closed");
    };
    const onOpen = () => {
      setError(null);
    };
    agent.addEventListener("error", onErr as EventListener);
    agent.addEventListener("close", onClose as EventListener);
    agent.addEventListener("open", onOpen as EventListener);
    return () => {
      agent.removeEventListener("error", onErr as EventListener);
      agent.removeEventListener("close", onClose as EventListener);
      agent.removeEventListener("open", onOpen as EventListener);
    };
  }, [agent]);

  return { agent, ready: agent.ready, error };
}
