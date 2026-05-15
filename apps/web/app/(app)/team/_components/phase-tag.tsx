"use client";

import type { CSSProperties } from "react";

/**
 * PhaseTag — small colored chip rendered on lead messages to mark the
 * conversational phase (planning, drafting, reviewing, etc.).
 *
 * In CF we don't yet have a `phase` column on messages — but the component
 * is reusable for tagging arbitrary message metadata (skill name,
 * platform, kind). Callers pass `label` and optionally `tone`.
 */

export type PhaseTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "error";

const TONE_COLORS: Record<PhaseTone, { bg: string; fg: string }> = {
  neutral: { bg: "var(--sf-bg-tertiary)", fg: "var(--sf-fg-2)" },
  accent: { bg: "var(--sf-accent-light)", fg: "var(--sf-accent)" },
  success: { bg: "var(--sf-success-light)", fg: "var(--sf-success-ink)" },
  warning: { bg: "var(--sf-warning-light)", fg: "var(--sf-warning-ink)" },
  error: { bg: "var(--sf-error-light)", fg: "var(--sf-error-ink)" },
};

export function PhaseTag({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: PhaseTone;
}) {
  const c = TONE_COLORS[tone];
  const tag: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "1px 7px",
    background: c.bg,
    color: c.fg,
    fontFamily: "var(--sf-font-mono)",
    fontSize: 10,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    borderRadius: 4,
    whiteSpace: "nowrap",
  };
  return <span style={tag}>{label}</span>;
}
