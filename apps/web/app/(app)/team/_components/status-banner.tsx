"use client";

import type { CSSProperties } from "react";

type ConnectionStatus = "idle" | "connecting" | "ready" | "sending" | "error";

interface StatusBannerProps {
  status: ConnectionStatus;
  error: string | null;
}

const BANNER_BASE: CSSProperties = {
  padding: "6px 16px",
  borderRadius: "var(--sf-radius-md)",
  fontSize: 13,
  fontFamily: "var(--sf-font-text)",
  marginBottom: 8,
  display: "flex",
  alignItems: "center",
  gap: 8,
};

export function StatusBanner({ status, error }: StatusBannerProps) {
  if (status === "ready" || status === "idle") return null;

  if (status === "error") {
    return (
      <div
        style={{
          ...BANNER_BASE,
          background: "var(--sf-error-light)",
          color: "var(--sf-error-ink)",
        }}
        role="alert"
      >
        <span aria-hidden="true">⚠</span>
        {error ?? "Connection error. Reload to reconnect."}
      </div>
    );
  }

  if (status === "connecting") {
    return (
      <div
        style={{
          ...BANNER_BASE,
          background: "var(--sf-accent-light)",
          color: "var(--sf-accent)",
        }}
        role="status"
        aria-live="polite"
      >
        <span aria-hidden="true">◌</span>
        Connecting to your team…
      </div>
    );
  }

  if (status === "sending") {
    return (
      <div
        style={{
          ...BANNER_BASE,
          background: "var(--sf-accent-light)",
          color: "var(--sf-accent)",
        }}
        role="status"
        aria-live="polite"
      >
        <span aria-hidden="true">↑</span>
        CMO is thinking…
      </div>
    );
  }

  return null;
}
