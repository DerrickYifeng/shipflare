"use client";

import type { CSSProperties } from "react";
import { ROLE_REGISTRY } from "@shipflare/shared";
import { AgentDot } from "./agent-dot";
import { roleCodeForRole } from "./agent-accent";
import { MessageMarkdown } from "./message-markdown";

interface LeadMessageProps {
  /** Slug from ROLE_REGISTRY (cmo / head-of-growth / social-media-manager / …). */
  from: string;
  /** Markdown body — may be empty during streaming. */
  content: string;
  /** ISO timestamp string. */
  createdAt: string;
  /** True while chunks are still arriving — appends the pulsing cursor. */
  streaming?: boolean;
  /** True when this message is an error result, not normal output. */
  isError?: boolean;
}

const CURSOR_STYLE: CSSProperties = {
  display: "inline-block",
  width: 8,
  height: 14,
  marginLeft: 2,
  verticalAlign: "text-bottom",
  borderRadius: 2,
  background: "var(--sf-fg-3)",
  opacity: 0.7,
  animation: "sf-blink 0.85s step-start infinite",
};

function displayNameForRole(role: string): string {
  const entry = (ROLE_REGISTRY as Record<string, { displayName: string } | undefined>)[role];
  return entry?.displayName ?? role;
}

export function LeadMessage({
  from,
  content,
  createdAt,
  streaming = false,
  isError = false,
}: LeadMessageProps) {
  const role = from || "cmo";
  const displayName = displayNameForRole(role);
  const time = new Date(createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const row: CSSProperties = {
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
    padding: "8px 4px",
  };

  const bubble: CSSProperties = {
    flex: 1,
    minWidth: 0,
    padding: "10px 14px",
    background: isError ? "var(--sf-error-light)" : "var(--sf-bg-secondary)",
    color: isError ? "var(--sf-error-ink)" : "var(--sf-fg-1)",
    border: `1px solid ${isError ? "var(--sf-error-ink)" : "var(--sf-border)"}`,
    borderRadius: "14px 14px 14px 4px",
    fontFamily: "var(--sf-font-text)",
    fontSize: 14,
    lineHeight: 1.55,
    boxShadow: "var(--sf-shadow-card)",
  };

  const header: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
    fontSize: 11,
    fontFamily: "var(--sf-font-mono)",
    color: "var(--sf-fg-3)",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  };

  return (
    <div style={row} role="article" aria-label={`${displayName} said`} aria-busy={streaming}>
      <AgentDot role={role} displayName={displayName} size={28} />
      <div style={bubble}>
        <div style={header}>
          <span style={{ fontWeight: 600, color: "var(--sf-fg-2)" }}>
            {isError ? "Error" : roleCodeForRole(role, displayName)}
          </span>
          <span aria-hidden="true">·</span>
          <span>{time}</span>
        </div>
        {isError ? (
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {content}
          </div>
        ) : (
          <>
            <MessageMarkdown source={content} />
            {streaming && <span style={CURSOR_STYLE} aria-hidden="true" />}
          </>
        )}
      </div>
    </div>
  );
}
