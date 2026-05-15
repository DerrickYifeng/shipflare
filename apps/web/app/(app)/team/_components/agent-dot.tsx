"use client";

import type { CSSProperties } from "react";
import { colorHexForRole, initialForRole } from "./agent-accent";

interface AgentDotProps {
  role: string;
  displayName: string;
  /** Diameter in px. Defaults to 28 (matches Railway's left-rail rows). */
  size?: number;
  /** Soft sf-pulse animation for "this agent is active right now". */
  pulse?: boolean;
}

/**
 * Monogram disc — solid brand color background + single-letter initial.
 * Faithful to Railway's AgentDot: NO gradients, NO inner shadow ring.
 */
export function AgentDot({
  role,
  displayName,
  size = 28,
  pulse = false,
}: AgentDotProps) {
  const dot: CSSProperties = {
    width: size,
    height: size,
    minWidth: size,
    borderRadius: "50%",
    background: colorHexForRole(role),
    color: "var(--sf-fg-on-dark-1)",
    fontFamily: "var(--sf-font-display)",
    fontSize: Math.max(10, Math.round(size * 0.5)),
    fontWeight: 600,
    letterSpacing: 0.2,
    lineHeight: 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    userSelect: "none",
    animation: pulse ? "sf-pulse 1.5s ease-in-out infinite" : undefined,
  };

  return (
    <div style={dot} aria-hidden="true" title={displayName}>
      {initialForRole(role, displayName)}
    </div>
  );
}
