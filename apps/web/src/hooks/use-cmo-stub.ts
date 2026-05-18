/**
 * useCmoStub — typed @callable RPC stub for CMO.
 *
 * Browser piggyback on the same WebSocket that `useCmoChat` opens
 * (the agents SDK de-dupes `useAgent` connections by `{agent, name}`
 * within a render tree). Authoritative wire shapes live in
 * `@shipflare/shared/cmo-callable`.
 *
 * Returns `{ stub, ready, error }`. `stub` is a stable object whose
 * methods call `agent.call(name, args)` under the hood. `ready` is the
 * agent's `Promise<void>` that resolves on first WS open. `error` is
 * non-null when the WS errored.
 *
 * Auth: same JWT route as `useCmoChat` (/api/agent-token?agent=cmo).
 * Per-callable auth is implicit — the WS upgrade at apps/core's
 * handleCmoWsRequest verifies claims.name === this.name; once the
 * connection exists on a DO, any callable invocation is owner-scoped.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { useAgent } from "agents/react";
import type {
  CmoCallableSurface,
  PlanItemRow,
  DraftRow,
  MemoryRow,
  AgentTranscriptRow,
  ConversationRow,
  RosterRow,
} from "@shipflare/shared";

async function fetchAgentJwt(agent: string, name?: string): Promise<string> {
  // SSR guard — useAgent's `query` callback runs via React 19's `use()` which
  // may run server-side via Suspense. fetch('/api/agent-token') with a
  // relative URL throws "Invalid URL" with no base, crashing the page render.
  // Mirror use-cmo-chat.ts's pattern: return empty token server-side; client
  // re-fetches on mount.
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

export interface UseCmoStubResult {
  stub: CmoCallableSurface;
  ready: Promise<void>;
  error: string | null;
}

export function useCmoStub({
  userId,
  coreHost,
}: {
  userId: string;
  coreHost?: string;
}): UseCmoStubResult {
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
    agent.addEventListener("error", onErr as EventListener);
    return () => agent.removeEventListener("error", onErr as EventListener);
  }, [agent]);

  const stub = useMemo<CmoCallableSurface>(() => {
    const call = <T,>(method: string, args?: unknown[]): Promise<T> =>
      agent.call<T>(method, args ?? []);

    return {
      queryFounderContext: () => call<Record<string, string>>("queryFounderContext"),
      queryPlanItems: (opts = {}) => call<PlanItemRow[]>("queryPlanItems", [opts]),
      cancelPlanItem: (args) => call<{ id: string; status: "cancelled" }>("cancelPlanItem", [args]),
      approveDraft: (args) => call<{ draftId: string; decision: "approved" }>("approveDraft", [args]),
      rejectDraft: (args) => call<{ draftId: string; decision: "rejected" }>("rejectDraft", [args]),
      queryDrafts: (opts = {}) => call<DraftRow[]>("queryDrafts", [opts]),
      rememberThis: (args) => call<{ id: string; ok: true }>("rememberThis", [args]),
      forgetThis: (args) => call<{ id: string; ok: true }>("forgetThis", [args]),
      queryMemory: (opts = {}) => call<MemoryRow[]>("queryMemory", [opts]),
      queryAgentTranscript: (args) => call<AgentTranscriptRow[]>("queryAgentTranscript", [args]),
      queryRoster: () => call<RosterRow[]>("queryRoster"),
      listConversations: (opts = {}) => call<ConversationRow[]>("listConversations", [opts]),
      startNewConversation: (args = {}) => call<{ conversationId: string }>("startNewConversation", [args]),
    };
  }, [agent]);

  return { stub, ready: agent.ready, error };
}
