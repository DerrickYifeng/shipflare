"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import type { TeamActivityMessage } from "@/hooks/use-team-events";

interface ConversationProps {
  messages: TeamActivityMessage[];
}

const EMPTY_STATE: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  color: "var(--sf-fg-4)",
  fontFamily: "var(--sf-font-text)",
  padding: 32,
  textAlign: "center",
};

const SCROLL_CONTAINER: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "16px 20px",
};

function MessageBubble({ msg }: { msg: TeamActivityMessage }) {
  const isUser = msg.type === "user_prompt";
  const isError = msg.type === "error";

  const bubble: CSSProperties = {
    maxWidth: "80%",
    padding: "10px 14px",
    borderRadius: isUser
      ? "14px 14px 4px 14px"
      : "14px 14px 14px 4px",
    fontFamily: "var(--sf-font-text)",
    fontSize: 14,
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    alignSelf: isUser ? "flex-end" : "flex-start",
    background: isError
      ? "var(--sf-error-light)"
      : isUser
        ? "var(--sf-accent)"
        : "var(--sf-bg-secondary)",
    color: isError
      ? "var(--sf-error-ink)"
      : isUser
        ? "var(--sf-fg-on-dark-1)"
        : "var(--sf-fg-1)",
    boxShadow: isUser ? "none" : "var(--sf-shadow-card)",
  };

  const meta: CSSProperties = {
    fontSize: 11,
    fontFamily: "var(--sf-font-mono)",
    color: "var(--sf-fg-4)",
    marginBottom: 4,
    alignSelf: isUser ? "flex-end" : "flex-start",
  };

  const label = isUser
    ? "You"
    : isError
      ? "Error"
      : msg.from === "cmo"
        ? "CMO"
        : (msg.from ?? "Team");

  const time = new Date(msg.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <span style={meta}>
        {label} · {time}
      </span>
      <div style={bubble} role="article" aria-label={`${label} said`}>
        {msg.content ?? ""}
      </div>
    </div>
  );
}

export function Conversation({ messages }: ConversationProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div style={EMPTY_STATE} role="status">
        <div style={{ fontSize: 32, opacity: 0.4 }}>💬</div>
        <div style={{ fontWeight: 600, fontSize: 15, color: "var(--sf-fg-2)" }}>
          Brief your team to get started
        </div>
        <div style={{ fontSize: 13 }}>
          Type a message below to talk with your CMO.
        </div>
      </div>
    );
  }

  return (
    <div style={SCROLL_CONTAINER} role="log" aria-label="Conversation" aria-live="polite">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} msg={msg} />
      ))}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}
