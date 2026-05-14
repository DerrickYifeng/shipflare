/**
 * `<ChatStream>` — client-side chat surface for the founder ↔ CMO loop.
 *
 * Mounts a single `CmoClient` over the MCP streamable HTTP transport, sends
 * one tool call per founder turn, and renders the running transcript. The
 * connection is opened on mount and closed on unmount so we don't leak SSE
 * streams between navigations.
 *
 * Phase 1 is request/response — `client.chat()` resolves to the full reply
 * in a single shot. Phase 2 will swap this for token streaming once the
 * core `chat` tool becomes a streamable MCP tool; the existing message-list
 * shape already accommodates incremental updates by reassigning the last
 * assistant entry.
 */

"use client";

import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createCmoClient, type CmoClient } from "@/lib/mcp-client";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** P2-D: timestamp captured when the message was rendered, used as
   *  `source_message_ts` when the founder hits "Remember". */
  ts?: number;
  /** P2-D: client-side remembered flag — flips the button to "Remembered"
   *  after a successful rememberThis round-trip so the founder doesn't
   *  double-save. Server doesn't deduplicate by content. */
  remembered?: boolean;
}

interface ChatStreamProps {
  conversationId: string;
}

export default function ChatStream({ conversationId }: ChatStreamProps) {
  const [client, setClient] = useState<CmoClient | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Open MCP connection on mount. Cleanup closes the transport — using a ref
  // to avoid stale-closure issues with the `client` state during unmount.
  const clientRef = useRef<CmoClient | null>(null);
  useEffect(() => {
    let cancelled = false;
    createCmoClient()
      .then((c) => {
        if (cancelled) {
          // React StrictMode double-invokes effects in dev; the second call
          // would replace `client` while the first is still alive. Close the
          // orphan immediately.
          void c.close();
          return;
        }
        clientRef.current = c;
        setClient(c);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error("Failed to connect MCP client:", err);
        setConnectError(msg);
      });
    return () => {
      cancelled = true;
      void clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  // Auto-scroll to newest message.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const send = useCallback(async () => {
    const trimmed = input.trim();
    if (!client || !trimmed || sending) return;
    setMessages((m) => [
      ...m,
      { role: "user", content: trimmed, ts: Date.now() },
    ]);
    setInput("");
    setSending(true);
    try {
      const reply = await client.chat(conversationId, trimmed);
      setMessages((m) => [
        ...m,
        { role: "assistant", content: reply, ts: Date.now() },
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `[error: ${msg}]`, ts: Date.now() },
      ]);
    } finally {
      setSending(false);
    }
  }, [client, conversationId, input, sending]);

  // P2-D — Save an assistant turn to long-term memory. We flip a local
  // `remembered` flag so the button can't double-fire (server doesn't dedupe
  // by content). Errors surface to console; we don't want a transient MCP
  // failure to wedge the chat surface.
  const remember = useCallback(
    async (index: number) => {
      const msg = messages[index];
      if (!client || !msg || msg.role !== "assistant" || msg.remembered) {
        return;
      }
      try {
        await client.rememberThis(msg.content, conversationId, msg.ts);
        setMessages((prev) =>
          prev.map((m, i) => (i === index ? { ...m, remembered: true } : m)),
        );
      } catch (err: unknown) {
        // eslint-disable-next-line no-console
        console.error("rememberThis failed:", err);
      }
    },
    [client, conversationId, messages],
  );

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <div
        style={{
          minHeight: 400,
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: "1rem",
          marginBottom: "1rem",
          overflowY: "auto",
          maxHeight: "60vh",
        }}
      >
        {connectError && (
          <p style={{ color: "#c33" }}>
            Connection error: {connectError}
          </p>
        )}
        {!connectError && messages.length === 0 && (
          <p style={{ color: "#888" }}>Say something to your CMO...</p>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: "1rem" }}>
            <strong>{m.role === "user" ? "You" : "CMO"}:</strong>
            <p style={{ whiteSpace: "pre-wrap", margin: "0.25rem 0" }}>
              {m.content}
            </p>
            {m.role === "assistant" && client && (
              <button
                onClick={() => void remember(i)}
                disabled={!!m.remembered}
                style={{
                  fontSize: "0.75em",
                  padding: "0.25rem 0.5rem",
                  marginTop: "0.25rem",
                }}
              >
                {m.remembered ? "Remembered" : "Remember"}
              </button>
            )}
          </div>
        ))}
        {sending && <p style={{ color: "#888" }}>CMO is thinking...</p>}
        <div ref={messagesEndRef} />
      </div>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message your CMO... (Enter to send, Shift+Enter for newline)"
        disabled={!client || sending}
        style={{
          width: "100%",
          minHeight: 80,
          padding: "0.5rem",
          fontFamily: "inherit",
          fontSize: "inherit",
          boxSizing: "border-box",
        }}
      />
      <button
        onClick={() => void send()}
        disabled={!client || sending || !input.trim()}
        style={{ marginTop: "0.5rem" }}
      >
        Send
      </button>
    </div>
  );
}
