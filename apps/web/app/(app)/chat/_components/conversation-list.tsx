/**
 * `<ConversationList>` — renders existing conversations + a "new" button.
 *
 * Pulls `listConversations` once on mount. Clicking a row navigates to
 * `/chat/<id>`; "New conversation" calls `startNewConversation` then
 * pushes to the freshly-returned id. We don't pre-create on mount because
 * starting a conversation persists a row in `conversations` — founders
 * shouldn't accumulate empty threads just by viewing the index.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createCmoClient, type CmoClient } from "@/lib/mcp-client";

interface Conversation {
  id: string;
  started_at: number;
  ended_at: number | null;
  title: string | null;
}

export default function ConversationList() {
  const router = useRouter();
  const [client, setClient] = useState<CmoClient | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const clientRef = useRef<CmoClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    createCmoClient()
      .then(async (c) => {
        if (cancelled) {
          void c.close();
          return;
        }
        clientRef.current = c;
        setClient(c);
        try {
          const rows = await c.listConversations(50);
          if (!cancelled) setConversations(rows);
        } catch (err: unknown) {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      });
    return () => {
      cancelled = true;
      void clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  async function startNew() {
    if (!client || creating) return;
    setCreating(true);
    try {
      const { conversationId } = await client.startNewConversation();
      router.push(`/chat/${conversationId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setCreating(false);
    }
    // Don't reset `creating` on success — we're navigating away, and
    // resetting would briefly re-enable the button while the route
    // transition is still in flight.
  }

  return (
    <div>
      {error && <p style={{ color: "#c33" }}>Error: {error}</p>}
      <button
        onClick={() => void startNew()}
        disabled={!client || creating}
        style={{ marginBottom: "1rem" }}
      >
        {creating ? "Creating..." : "New conversation"}
      </button>
      {!error && conversations.length === 0 && (
        <p style={{ color: "#888" }}>No conversations yet. Start one.</p>
      )}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {conversations.map((c) => (
          <li
            key={c.id}
            style={{
              padding: "0.5rem 0",
              borderBottom: "1px solid #f0f0f0",
            }}
          >
            <Link href={`/chat/${c.id}`}>
              {c.title ?? `Conversation ${c.id.slice(0, 8)}`}
            </Link>
            <span
              style={{
                color: "#888",
                marginLeft: "0.5rem",
                fontSize: "0.875em",
              }}
            >
              {new Date(c.started_at).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
