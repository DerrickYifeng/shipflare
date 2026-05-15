"use client";

import type { CSSProperties } from "react";

interface EmptyConversationProps {
  onPromptSelect?: (prompt: string) => void;
}

const PROMPTS: ReadonlyArray<string> = [
  "What should I post on X today?",
  "Find me 10 active subreddits I should be in",
  "Draft a thread on shipping fast as a solo founder",
  "Summarize this week's growth signal",
  "Plan my marketing for next 7 days",
];

const WRAP: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  padding: 48,
  textAlign: "center",
};

const TITLE: CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: "var(--sf-fg-1)",
  fontFamily: "var(--sf-font-display)",
  letterSpacing: "var(--sf-track-tight)",
};

const SUBTITLE: CSSProperties = {
  fontSize: 14,
  color: "var(--sf-fg-3)",
  maxWidth: 440,
  lineHeight: 1.55,
  fontFamily: "var(--sf-font-text)",
};

const CHIP_ROW: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "center",
  gap: 8,
  maxWidth: 560,
  marginTop: 8,
};

const CHIP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "8px 14px",
  borderRadius: "var(--sf-radius-pill)",
  border: "1px solid var(--sf-border)",
  background: "var(--sf-bg-secondary)",
  color: "var(--sf-fg-2)",
  fontSize: 13,
  fontFamily: "var(--sf-font-text)",
  fontWeight: 500,
  cursor: "pointer",
  transition: "background var(--sf-dur-fast) var(--sf-ease-swift), color var(--sf-dur-fast) var(--sf-ease-swift), border-color var(--sf-dur-fast) var(--sf-ease-swift)",
};

const ICON: CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: "50%",
  background:
    "linear-gradient(135deg, var(--sf-accent-light), var(--sf-accent))",
  color: "var(--sf-fg-on-dark-1)",
  fontSize: 22,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  boxShadow: "var(--sf-shadow-card)",
};

export function EmptyConversation({ onPromptSelect }: EmptyConversationProps) {
  return (
    <div style={WRAP} role="status">
      <div style={ICON} aria-hidden="true">
        ✦
      </div>
      <div style={TITLE}>Brief your team to get started</div>
      <div style={SUBTITLE}>
        Type a message below to talk with your CMO — or pick one of these to skip
        the blank canvas.
      </div>
      {onPromptSelect && (
        <div style={CHIP_ROW}>
          {PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              style={CHIP}
              onClick={() => onPromptSelect(prompt)}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--sf-accent-light)";
                e.currentTarget.style.color = "var(--sf-accent)";
                e.currentTarget.style.borderColor = "var(--sf-accent)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--sf-bg-secondary)";
                e.currentTarget.style.color = "var(--sf-fg-2)";
                e.currentTarget.style.borderColor = "var(--sf-border)";
              }}
            >
              {prompt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
