"use client";

import type { CSSProperties } from "react";
import {
  avatarGradientForRole,
  initialForRole,
} from "./agent-accent";

interface AgentDotProps {
  role: string;
  displayName: string;
  size?: number;
}

/**
 * Circle avatar with monogram + brand gradient for a teammate.
 * Default size 28px (left-rail row); pass `size` for hero contexts.
 */
export function AgentDot({ role, displayName, size = 28 }: AgentDotProps) {
  const dot: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    background: avatarGradientForRole(role),
    color: "var(--sf-fg-on-dark-1)",
    fontSize: Math.round(size * 0.42),
    fontWeight: 600,
    fontFamily: "var(--sf-font-text)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.06)",
    letterSpacing: 0,
  };

  return (
    <div
      style={dot}
      aria-hidden="true"
      title={displayName}
    >
      {initialForRole(role, displayName)}
    </div>
  );
}
