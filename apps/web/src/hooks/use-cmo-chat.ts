/**
 * useCmoChat — chat UI bindings for a founder's CMO DO.
 *
 * Takes a pre-created agent from `useCmoAgent` so chat + RPC stub share
 * ONE WebSocket per page tree.
 *
 * Returns the messages / sendMessage / streaming surface from
 * `@cloudflare/ai-chat/react`'s `useAgentChat`, plus the nested
 * agent-tool run timelines from `agents/react`'s `useAgentToolEvents`.
 */

"use client";

import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgentToolEvents } from "agents/react";
import type { CmoAgent } from "./use-cmo-agent";

export interface UseCmoChatResult {
  messages: ReturnType<typeof useAgentChat>["messages"];
  sendMessage: ReturnType<typeof useAgentChat>["sendMessage"];
  isStreaming: ReturnType<typeof useAgentChat>["isStreaming"];
  stop: ReturnType<typeof useAgentChat>["stop"];
  agentRuns: ReturnType<typeof useAgentToolEvents>["runsById"];
  agentRunsByToolCall: ReturnType<typeof useAgentToolEvents>["runsByToolCallId"];
}

export function useCmoChat({
  agent,
  conversationId,
}: {
  agent: CmoAgent;
  conversationId?: string;
}): UseCmoChatResult {
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
