/**
 * `<MemoryClient>` — list + forget UI for the founder's long-term memories.
 *
 * Mounts a single `CmoClient` on the streamable HTTP transport, fetches the
 * active memory rows on mount, and re-fetches after a successful `forget`
 * round-trip (simplest correctness model: always trust the server). Close
 * the transport on unmount so we don't leak SSE.
 *
 * Phase 1 — request/response only. No optimistic local removal yet; the
 * server reply is cheap and keeps client state in sync with `active=1`.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { createCmoClient, type CmoClient } from "@/lib/mcp-client";

interface Memory {
  id: string;
  content: string;
  added_at: number;
  source_conversation_id: string | null;
}

export default function MemoryClient() {
  const clientRef = useRef<CmoClient | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forgettingId, setForgettingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    createCmoClient()
      .then(async (c) => {
        if (cancelled) {
          await c.close();
          return;
        }
        clientRef.current = c;
        const rows = await c.queryMemory(100);
        if (cancelled) return;
        setMemories(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      void clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  async function forget(id: string): Promise<void> {
    const client = clientRef.current;
    if (!client) return;
    setForgettingId(id);
    try {
      await client.forgetThis(id);
      const rows = await client.queryMemory(100);
      setMemories(rows);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setForgettingId(null);
    }
  }

  return (
    <div>
      {error && (
        <p style={{ color: "crimson" }}>Error: {error}</p>
      )}
      {loading && !error && <p style={{ color: "#888" }}>Loading...</p>}
      {!loading && !error && memories.length === 0 && (
        <p style={{ color: "#888" }}>
          No memories yet. Use the &ldquo;Remember&rdquo; button on a CMO
          message in chat to add one.
        </p>
      )}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {memories.map((m) => (
          <li
            key={m.id}
            style={{
              border: "1px solid #ddd",
              borderRadius: 8,
              padding: "1rem",
              marginBottom: "1rem",
            }}
          >
            <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{m.content}</p>
            <div
              style={{
                marginTop: "0.5rem",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ color: "#888", fontSize: "0.875em" }}>
                Added {new Date(m.added_at).toLocaleString()}
              </span>
              <button
                onClick={() => void forget(m.id)}
                disabled={forgettingId === m.id}
              >
                {forgettingId === m.id ? "Forgetting..." : "Forget"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
