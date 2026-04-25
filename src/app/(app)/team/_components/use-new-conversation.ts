'use client';

import { useCallback, useState } from 'react';
import type { ConversationMeta } from './conversation-meta';

export interface UseNewConversationOptions {
  teamId: string;
  onCreated: (conv: ConversationMeta) => void;
  onError?: (err: unknown) => void;
}

export interface UseNewConversationReturn {
  start: () => void;
  /** True while `POST /api/team/conversations` is in-flight. */
  creating: boolean;
}

interface CreatedResponse {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/**
 * Creates a new empty conversation on the server and hands it to the
 * caller to become the focused thread. ChatGPT-style: the "+ New"
 * button mints a real server row immediately, not a client placeholder
 * — simpler state machine (no draft → promote flow), and the user can
 * bounce between conversations without losing an un-sent draft's slot.
 */
export function useNewConversation({
  teamId,
  onCreated,
  onError,
}: UseNewConversationOptions): UseNewConversationReturn {
  const [creating, setCreating] = useState(false);

  const start = useCallback(() => {
    setCreating(true);
    void fetch('/api/team/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId }),
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`create failed: HTTP ${res.status}`);
        }
        const body = (await res.json()) as CreatedResponse;
        onCreated({
          id: body.id,
          title: body.title,
          createdAt: body.createdAt,
          updatedAt: body.updatedAt,
          isDraft: false,
        });
      })
      .catch((err) => {
        onError?.(err);
      })
      .finally(() => setCreating(false));
  }, [teamId, onCreated, onError]);

  return { start, creating };
}
