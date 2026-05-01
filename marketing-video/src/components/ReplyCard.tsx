import type { CSSProperties } from "react";
import type { ReplyDraft } from "../lib/data";
import { PlatformGlyph } from "./PlatformGlyph";

interface ReplyCardProps {
  reply: ReplyDraft;
  /** "ready" → default · "sending" → progress bar · "sent" → green button */
  state?: "ready" | "sending" | "sent";
  /** 0–1, scales an Apple-Blue outline to highlight click moments */
  highlight?: number;
  style?: CSSProperties;
}

export const ReplyCard: React.FC<ReplyCardProps> = ({
  reply,
  state = "ready",
  highlight = 0,
  style,
}) => {
  const len = reply.draftBody.length;
  return (
    <article
      style={{
        position: "relative",
        background: "var(--sf-bg-secondary)",
        borderRadius: 18,
        boxShadow: "var(--sf-shadow-card)",
        border: "1px solid rgba(0,0,0,0.06)",
        outline:
          highlight > 0 ? `${2 * highlight}px solid var(--sf-accent)` : "none",
        outlineOffset: 4,
        overflow: "hidden",
        fontFamily: "var(--sf-font-text)",
        ...style,
      }}
    >
      {state === "sending" ? <ProgressBar /> : null}
      <Header reply={reply} />
      <ThreadQuote body={reply.threadBody} />
      <DraftBody body={reply.draftBody} />
      <Footer state={state} len={len} cap={reply.charCap} />
    </article>
  );
};

const Header: React.FC<{ reply: ReplyDraft }> = ({ reply }) => (
  <header
    style={{
      display: "flex",
      alignItems: "center",
      gap: 14,
      padding: "20px 24px",
      borderBottom: "1px solid rgba(0,0,0,0.06)",
    }}
  >
    <PlatformGlyph platform={reply.platform} />
    <div style={{ flex: 1 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
        }}
      >
        <span
          style={{
            fontSize: 22,
            fontWeight: 600,
            color: "var(--sf-fg-1)",
            letterSpacing: "-0.374px",
          }}
        >
          {reply.authorName}
        </span>
        <span
          style={{
            fontSize: 18,
            color: "var(--sf-fg-3)",
            letterSpacing: "-0.224px",
          }}
        >
          {reply.authorHandle} · {reply.postedRelative}
        </span>
      </div>
      <div
        style={{
          marginTop: 4,
          fontFamily: "var(--sf-font-mono)",
          fontSize: 15,
          color: "var(--sf-fg-3)",
          letterSpacing: "-0.12px",
        }}
      >
        ♥ {reply.likes.toLocaleString("en-US")}
      </div>
    </div>
    <ConfidenceBadge value={reply.confidence} />
  </header>
);

const ConfidenceBadge: React.FC<{ value: number }> = ({ value }) => (
  <span
    style={{
      padding: "8px 14px",
      borderRadius: 999,
      background: "var(--sf-success-light)",
      color: "var(--sf-success-ink)",
      fontFamily: "var(--sf-font-mono)",
      fontSize: 16,
      fontWeight: 600,
      letterSpacing: "-0.12px",
    }}
  >
    {value}%
  </span>
);

const ThreadQuote: React.FC<{ body: string }> = ({ body }) => (
  <div style={{ padding: "20px 24px 6px" }}>
    <blockquote
      style={{
        margin: 0,
        padding: "0 0 0 18px",
        borderLeft: "3px solid rgba(0,0,0,0.12)",
        fontSize: 20,
        lineHeight: 1.4,
        color: "var(--sf-fg-2)",
        letterSpacing: "-0.374px",
      }}
    >
      {body}
    </blockquote>
  </div>
);

const DraftBody: React.FC<{ body: string }> = ({ body }) => (
  <div style={{ padding: "18px 24px 8px" }}>
    <div
      style={{
        fontFamily: "var(--sf-font-mono)",
        fontSize: 14,
        textTransform: "uppercase",
        letterSpacing: "-0.12px",
        color: "var(--sf-fg-3)",
        marginBottom: 12,
      }}
    >
      Your draft reply
    </div>
    <p
      style={{
        margin: 0,
        fontSize: 24,
        lineHeight: 1.45,
        letterSpacing: "-0.374px",
        color: "var(--sf-fg-1)",
      }}
    >
      {body}
    </p>
  </div>
);

const Footer: React.FC<{ state: string; len: number; cap: number }> = ({
  state,
  len,
  cap,
}) => {
  const label =
    state === "sent"
      ? "Sent ✓"
      : state === "sending"
        ? "Sending…"
        : "Send reply";
  const isSent = state === "sent";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "18px 24px",
        borderTop: "1px solid rgba(0,0,0,0.06)",
        background: "rgba(0,0,0,0.02)",
      }}
    >
      <button
        type="button"
        style={{
          height: 48,
          padding: "0 26px",
          borderRadius: 10,
          border: "none",
          background: isSent ? "var(--sf-success)" : "var(--sf-accent)",
          color: "#fff",
          fontFamily: "var(--sf-font-text)",
          fontSize: 18,
          fontWeight: 500,
          cursor: "default",
        }}
      >
        {label}
      </button>
      <TextButton>Edit</TextButton>
      <TextButton>Skip</TextButton>
      <span style={{ flex: 1 }} />
      <span
        style={{
          fontFamily: "var(--sf-font-mono)",
          fontSize: 15,
          color: len > cap ? "var(--sf-error)" : "var(--sf-fg-3)",
          letterSpacing: "-0.12px",
        }}
      >
        {len} / {cap}
      </span>
    </div>
  );
};

const TextButton: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    style={{
      padding: "10px 14px",
      fontSize: 16,
      color: "var(--sf-fg-2)",
      letterSpacing: "-0.224px",
    }}
  >
    {children}
  </span>
);

const ProgressBar: React.FC = () => (
  <div
    style={{
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: 3,
      background: "var(--sf-accent)",
    }}
  />
);
