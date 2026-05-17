"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import type { UIMessage } from "ai";
import { LeadMessage } from "./lead-message";
import { UserMessage } from "./user-message";
import { EmptyConversation } from "./empty-conversation";
import { TypingIndicator } from "./typing-indicator";

interface ConversationProps {
  /** UIMessages from `useCmoChat` (Phase 8). */
  messages: UIMessage[];
  /** True while the assistant stream is in flight. */
  isStreaming: boolean;
  /** Nested-agent run timelines keyed by tool-call id (from `consult`). */
  agentRunsByToolCall: Record<string, unknown[]>;
  onPromptSelect?: (prompt: string) => void;
}

const SCROLL_CONTAINER: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "16px 20px",
};

function extractText(msg: UIMessage): string {
  const buf: string[] = [];
  for (const part of msg.parts as Array<Record<string, unknown>>) {
    if (part["type"] === "text") {
      const t = part["text"];
      if (typeof t === "string") buf.push(t);
    }
  }
  return buf.join("");
}

export function Conversation({
  messages,
  isStreaming,
  agentRunsByToolCall,
  onPromptSelect,
}: ConversationProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive or the last message grows
  // (streaming chunks landing). We re-trigger on the tail message's textual
  // length so token deltas still cause scroll.
  const last = messages[messages.length - 1];
  const lastText = last ? extractText(last) : "";
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, lastText.length]);

  if (messages.length === 0) {
    return <EmptyConversation onPromptSelect={onPromptSelect} />;
  }

  // Show typing dots when the trailing message is an assistant with no
  // rendered content yet (parts empty or only an empty text part) and the
  // stream is still active.
  const showTyping =
    !!last && last.role === "assistant" && isStreaming && lastText.length === 0;

  return (
    <div
      style={SCROLL_CONTAINER}
      role="log"
      aria-label="Conversation"
      aria-live="polite"
    >
      {messages.map((msg) => {
        if (msg.role === "user") {
          // UIMessage doesn't carry a structured submission timestamp — the
          // previous render-time `new Date()` stamp was a visual bug (jittered
          // on re-render). The UserMessage component doesn't display a
          // timestamp anyway, so drop the prop. If per-user-message timestamps
          // become required again, capture them at submit time in the
          // message metadata and surface via msg.metadata.createdAt.
          return (
            <UserMessage key={msg.id} content={extractText(msg)} />
          );
        }

        if (msg.role === "assistant") {
          // Skip the empty placeholder when we're rendering the typing
          // indicator below it.
          if (showTyping && msg === last) return null;
          const isLast = msg === last;
          return (
            <div key={msg.id}>
              <LeadMessage
                parts={msg.parts}
                streaming={isLast && isStreaming}
                agentRunsByToolCall={agentRunsByToolCall}
              />
            </div>
          );
        }

        // system messages — render as plain text only.
        const text = extractText(msg);
        if (!text) return null;
        return (
          <div key={msg.id} style={{ fontSize: 12, color: "var(--sf-fg-3)", margin: "8px 0" }}>
            {text}
          </div>
        );
      })}
      {showTyping && <TypingIndicator role="cmo" />}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}
