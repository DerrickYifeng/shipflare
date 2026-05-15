"use client";

import type { CSSProperties } from "react";

export type AgentStatus =
  | "active"
  | "idle"
  | "fired"
  | "working"
  | "waiting";

interface AgentStatusPillProps {
  status: AgentStatus;
  /** Optional in-flight count to render after the status label. */
  taskCount?: number;
}

const PILL_STYLES: Record<AgentStatus, { bg: string; fg: string; label: string }> = {
  active: { bg: "var(--sf-success-light)", fg: "var(--sf-success-ink)", label: "Active" },
  working: { bg: "var(--sf-warning-light)", fg: "var(--sf-warning-ink)", label: "Working" },
  waiting: { bg: "var(--sf-accent-light)", fg: "var(--sf-accent)", label: "Waiting" },
  idle: { bg: "var(--sf-bg-tertiary)", fg: "var(--sf-fg-3)", label: "Idle" },
  fired: { bg: "var(--sf-error-light)", fg: "var(--sf-error-ink)", label: "Fired" },
};

export function AgentStatusPill({ status, taskCount }: AgentStatusPillProps) {
  const s = PILL_STYLES[status];
  const pill: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "1px 7px",
    background: s.bg,
    color: s.fg,
    fontFamily: "var(--sf-font-mono)",
    fontSize: 10,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    borderRadius: "var(--sf-radius-pill)",
    whiteSpace: "nowrap",
  };
  return (
    <span style={pill} aria-label={`Status: ${s.label}`}>
      {s.label}
      {taskCount !== undefined && taskCount > 0 && (
        <span style={{ opacity: 0.7 }}>· {taskCount}</span>
      )}
    </span>
  );
}
