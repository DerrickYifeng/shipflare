"use client";

import type { CSSProperties } from "react";
import { ROLE_REGISTRY } from "@shipflare/shared";
import { AgentDot } from "./agent-dot";

interface TypingIndicatorProps {
  role: string;
}

const wrap: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 4px",
};

const bubble: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "10px 14px",
  background: "var(--sf-bg-secondary)",
  border: "1px solid var(--sf-border)",
  borderRadius: "14px 14px 14px 4px",
  boxShadow: "var(--sf-shadow-card)",
};

const dot = (delay: number): CSSProperties => ({
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--sf-fg-3)",
  animation: "sf-typing-bounce 1.1s ease-in-out infinite",
  animationDelay: `${delay}ms`,
});

const label: CSSProperties = {
  fontSize: 12,
  fontFamily: "var(--sf-font-mono)",
  color: "var(--sf-fg-3)",
  marginLeft: 4,
  letterSpacing: 0.3,
};

function displayNameForRole(role: string): string {
  const entry = (ROLE_REGISTRY as Record<string, { displayName: string } | undefined>)[role];
  return entry?.displayName ?? role;
}

export function TypingIndicator({ role }: TypingIndicatorProps) {
  const displayName = displayNameForRole(role || "cmo");

  return (
    <div style={wrap} aria-label={`${displayName} is thinking`}>
      <AgentDot role={role || "cmo"} displayName={displayName} size={28} />
      <div style={bubble}>
        <span style={dot(0)} aria-hidden="true" />
        <span style={dot(150)} aria-hidden="true" />
        <span style={dot(300)} aria-hidden="true" />
        <span style={label}>{displayName} is thinking…</span>
      </div>
      <style>{`
        @keyframes sf-typing-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-3px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
