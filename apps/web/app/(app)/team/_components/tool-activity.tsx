"use client";

import type { CSSProperties } from "react";

interface ToolActivityProps {
  /** Tool name (e.g. "xai_find_customers"). */
  tool: string;
  /** Optional progress text (e.g. "searching X for 'agent builders'…"). */
  message?: string;
  /** True while still mid-flight, false once the tool returned. */
  pending?: boolean;
}

const row: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 10px",
  margin: "2px 0",
  fontFamily: "var(--sf-font-mono)",
  fontSize: 11,
  color: "var(--sf-fg-3)",
  borderRadius: 6,
  background: "var(--sf-bg-tertiary)",
};

const spinner: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  border: "2px solid var(--sf-fg-4)",
  borderTopColor: "var(--sf-accent)",
  animation: "sf-status-spin 0.8s linear infinite",
};

const dot: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--sf-success)",
};

export function ToolActivity({ tool, message, pending = true }: ToolActivityProps) {
  return (
    <div style={row} role="status" aria-label={`Tool ${tool} ${pending ? "running" : "done"}`}>
      {pending ? <span style={spinner} aria-hidden="true" /> : <span style={dot} aria-hidden="true" />}
      <span style={{ fontWeight: 600 }}>{tool}</span>
      {message && <span>· {message}</span>}
    </div>
  );
}
