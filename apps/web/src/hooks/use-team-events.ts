'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createCmoClient, type CmoClient } from '@/lib/mcp-client';

// ---------------------------------------------------------------------------
// Types — preserved from the Railway-era hook so existing UI components and
// reducers don't need to change. In Phase 1 we only emit `user_prompt` +
// `agent_text` + the terminal `error`. Other variants are still part of the
// type to keep callers compiling; they're not produced by this hook.
// ---------------------------------------------------------------------------

export type TeamMessageType =
  | 'user_prompt'
  | 'agent_text'
  | 'tool_call'
  | 'tool_result'
  | 'tool_progress'
  | 'completion'
  | 'error'
  | 'thinking'
  | 'agent_text_start'
  | 'agent_text_delta'
  | 'agent_text_stop'
  | 'tool_input_delta';

export interface TeamActivityMessage {
  id: string;
  runId: string | null;
  /**
   * The conversation this message belongs to. Required for the
   * ChatGPT-style thread filter — the UI only renders messages whose
   * conversationId matches the focused conversation.
   */
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
  conversationId?: string | null;
  runId?: string | null;
}

export interface UseTeamEventsResult {
  messages: TeamActivityMessage[];
  sendMessage: (text: string) => Promise<void>;
  status: 'idle' | 'connecting' | 'ready' | 'sending' | 'error';
  error: string | null;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTeamEvents(opts: UseTeamEventsOptions): UseTeamEventsResult {
  const { teamId, conversationId } = opts;
  const [messages, setMessages] = useState<TeamActivityMessage[]>([]);
  const [status, setStatus] = useState<UseTeamEventsResult['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<CmoClient | null>(null);

  // Connect on mount, close on unmount.
  useEffect(() => {
    let cancelled = false;
    setStatus('connecting');
    setError(null);

    (async () => {
      try {
        const client = await createCmoClient();
        if (cancelled) {
          await client.close().catch(() => {});
          return;
        }
        clientRef.current = client;
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to connect to CMO');
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      const c = clientRef.current;
      clientRef.current = null;
      if (c) c.close().catch(() => {});
    };
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const client = clientRef.current;
      if (!client) {
        setError('CMO client not connected');
        return;
      }

      const now = new Date().toISOString();
      const userTurn: TeamActivityMessage = {
        id: makeId(),
        runId: null,
        conversationId: conversationId ?? null,
        teamId,
        from: 'founder',
        to: 'cmo',
        type: 'user_prompt',
        content: text,
        metadata: null,
        createdAt: now,
      };

      // Insert a streaming placeholder for the assistant reply immediately so
      // chunks paint to the UI as they arrive, before the tool result lands.
      const assistantId = makeId();
      const placeholder: TeamActivityMessage = {
        id: assistantId,
        runId: null,
        conversationId: conversationId ?? null,
        teamId,
        from: 'cmo',
        to: 'founder',
        type: 'agent_text',
        content: '',
        metadata: { streaming: true },
        createdAt: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, userTurn, placeholder]);
      setStatus('sending');
      setError(null);

      try {
        let acc = '';
        const replyText = await client.chat(
          conversationId ?? '',
          text,
          (chunk) => {
            acc += chunk;
            // Update the placeholder content in-place as chunks arrive.
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: acc } : m,
              ),
            );
          },
        );

        // Final reconciliation: use the server's authoritative text and clear
        // the streaming flag so the UI shows the stable finished state.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: replyText, metadata: null }
              : m,
          ),
        );
        setStatus('ready');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'chat failed';
        setError(errMsg);
        // Remove the streaming placeholder and replace with an error turn.
        const errorTurn: TeamActivityMessage = {
          id: makeId(),
          runId: null,
          conversationId: conversationId ?? null,
          teamId,
          from: 'cmo',
          to: 'founder',
          type: 'error',
          content: errMsg,
          metadata: null,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== assistantId),
          errorTurn,
        ]);
        setStatus('error');
      }
    },
    [teamId, conversationId],
  );

  return { messages, sendMessage, status, error };
}
