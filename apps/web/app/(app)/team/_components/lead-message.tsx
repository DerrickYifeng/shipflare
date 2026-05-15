"use client";

import { memo, type CSSProperties } from "react";
import { ROLE_REGISTRY } from "@shipflare/shared";
import { AgentDot } from "./agent-dot";
import { MessageMarkdown } from "./message-markdown";

interface LeadMessageProps {
  /** Slug from ROLE_REGISTRY (cmo / head-of-growth / social-media-manager / …). */
  from: string;
  /** Markdown body — may be empty during streaming. */
  content: string;
  /** ISO timestamp string. */
  createdAt: string;
  /** True while chunks are still arriving — appends a soft breathing dot row. */
  streaming?: boolean;
  /** True when this message is an error result, not normal output. */
  isError?: boolean;
}

function displayNameForRole(role: string): string {
  const entry = (ROLE_REGISTRY as Record<string, { displayName: string } | undefined>)[role];
  return entry?.displayName ?? role;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

const row: CSSProperties = {
  display: "flex",
  gap: 10,
  marginBottom: 14,
  animation: "sf-fade-in var(--sf-dur-slow, 300ms) var(--sf-ease-swift)",
};

const body: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 0,
  flex: 1,
};

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
};

const name: CSSProperties = {
  fontWeight: 500,
  color: "var(--sf-fg-1)",
  letterSpacing: "-0.01em",
};

const time: CSSProperties = {
  fontFamily: "var(--sf-font-mono)",
  fontSize: 11,
  color: "rgba(0, 0, 0, 0.48)",
  fontVariantNumeric: "tabular-nums",
};

function LeadMessageImpl({
  from,
  content,
  createdAt,
  streaming = false,
  isError = false,
}: LeadMessageProps) {
  const role = from || "cmo";
  const displayName = displayNameForRole(role);

  return (
    <div
      style={row}
      role="article"
      aria-label={`${displayName} said`}
      aria-busy={streaming}
      data-streaming={streaming ? "true" : "false"}
    >
      <AgentDot role={role} displayName={displayName} size={28} />
      <div style={body}>
        <div style={header}>
          <span style={name}>{displayName}</span>
          <time dateTime={createdAt} style={time}>
            {formatClock(createdAt)}
          </time>
        </div>
        {isError ? (
          <div
            style={{
              fontSize: 14,
              color: "var(--sf-error-ink)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "var(--sf-font-text)",
            }}
          >
            {content}
          </div>
        ) : content || streaming ? (
          <div style={{ fontSize: 14, color: "var(--sf-fg-1)" }}>
            <MessageMarkdown source={content} />
            {streaming && <StreamingDots />}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const LeadMessage = memo(LeadMessageImpl);

/**
 * Three-dot breathing indicator, inline at the end of a streaming bubble.
 * Matches Railway's StreamingDots exactly.
 */
function StreamingDots() {
  const wrap: CSSProperties = {
    display: "inline-flex",
    gap: 3,
    alignItems: "center",
    marginLeft: 6,
    verticalAlign: "baseline",
  };
  const dot: CSSProperties = {
    width: 5,
    height: 5,
    borderRadius: "50%",
    background: "currentColor",
    opacity: 0.35,
    animation: "sf-breathe 1.2s ease-in-out infinite",
  };
  return (
    <span style={wrap} aria-label="Still streaming">
      <span style={{ ...dot, animationDelay: "0ms" }} />
      <span style={{ ...dot, animationDelay: "180ms" }} />
      <span style={{ ...dot, animationDelay: "360ms" }} />
      <style>{`
        @keyframes sf-breathe {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.85); }
          40% { opacity: 0.9; transform: scale(1.1); }
        }
      `}</style>
    </span>
  );
}
