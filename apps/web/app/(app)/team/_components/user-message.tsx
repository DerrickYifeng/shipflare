"use client";

import type { CSSProperties } from "react";

interface UserMessageProps {
  content: string;
}

const row: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  marginBottom: 14,
  animation: "sf-fade-in var(--sf-dur-slow, 300ms) var(--sf-ease-swift)",
};

const bubble: CSSProperties = {
  maxWidth: "78%",
  background: "var(--sf-accent)",
  color: "var(--sf-fg-on-dark-1)",
  padding: "10px 14px",
  borderRadius: 14,
  fontFamily: "var(--sf-font-text)",
  fontSize: 14,
  letterSpacing: "-0.01em",
  lineHeight: 1.47,
  boxShadow: "0 1px 2px rgba(0, 0, 0, 0.06)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

export function UserMessage({ content }: UserMessageProps) {
  return (
    <div style={row} role="article" aria-label="You said">
      <div style={bubble}>{content}</div>
    </div>
  );
}
