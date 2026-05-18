/**
 * useCmoStub — typed @callable RPC stub for CMO.
 *
 * Takes a pre-created agent from `useCmoAgent` so chat + RPC stub share
 * ONE WebSocket per page tree (the agents SDK does NOT de-dupe
 * `useAgent` calls per-options; each call opens its own socket).
 *
 * Authoritative wire shapes live in `@shipflare/shared/cmo-callable`.
 *
 * Returns the stable typed stub. Errors and ready-state come from
 * `useCmoAgent`'s result.
 */

"use client";

import { useMemo } from "react";
import type {
  CmoCallableSurface,
  PlanItemRow,
  DraftRow,
  MemoryRow,
  AgentTranscriptRow,
  ConversationRow,
  RosterRow,
} from "@shipflare/shared";
import type { CmoAgent } from "./use-cmo-agent";

export function useCmoStub({ agent }: { agent: CmoAgent }): CmoCallableSurface {
  return useMemo<CmoCallableSurface>(() => {
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
}
