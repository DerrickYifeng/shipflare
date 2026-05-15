"use client";

import type { CSSProperties } from "react";

interface UserMessageProps {
  content: string;
  createdAt: string;
}

export function UserMessage({ content, createdAt }: UserMessageProps) {
  const time = new Date(createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const wrap: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 2,
    padding: "8px 4px",
  };

  const meta: CSSProperties = {
    fontSize: 11,
    fontFamily: "var(--sf-font-mono)",
    color: "var(--sf-fg-3)",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    paddingRight: 6,
  };

  const bubble: CSSProperties = {
    maxWidth: "78%",
    padding: "10px 14px",
    background: "var(--sf-accent)",
    color: "var(--sf-fg-on-dark-1)",
    borderRadius: "14px 14px 4px 14px",
    fontFamily: "var(--sf-font-text)",
    fontSize: 14,
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };

  return (
    <div style={wrap} role="article" aria-label="You said">
      <span style={meta}>You · {time}</span>
      <div style={bubble}>{content}</div>
    </div>
  );
}
