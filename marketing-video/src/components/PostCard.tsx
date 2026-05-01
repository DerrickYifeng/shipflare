import type { CSSProperties } from "react";
import type { PostDraft } from "../lib/data";
import { PlatformGlyph } from "./PlatformGlyph";

interface PostCardProps {
  post: PostDraft;
  style?: CSSProperties;
}

export const PostCard: React.FC<PostCardProps> = ({ post, style }) => {
  const len = post.draftBody.length;
  return (
    <article
      style={{
        background: "var(--sf-bg-secondary)",
        borderRadius: 18,
        boxShadow: "var(--sf-shadow-card)",
        border: "1px solid rgba(0,0,0,0.06)",
        overflow: "hidden",
        fontFamily: "var(--sf-font-text)",
        ...style,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "20px 24px",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
        }}
      >
        <PlatformGlyph platform={post.platform} />
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 22,
              fontWeight: 600,
              color: "var(--sf-fg-1)",
              letterSpacing: "-0.374px",
            }}
          >
            {post.contentType} post
          </div>
          <div
            style={{
              marginTop: 4,
              fontFamily: "var(--sf-font-mono)",
              fontSize: 14,
              textTransform: "uppercase",
              letterSpacing: "-0.12px",
              color: "var(--sf-fg-3)",
            }}
          >
            Original · X
          </div>
        </div>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 14px",
            borderRadius: 999,
            fontFamily: "var(--sf-font-mono)",
            fontSize: 16,
            fontWeight: 600,
            background: "var(--sf-accent-light)",
            color: "var(--sf-link)",
            letterSpacing: "-0.12px",
          }}
        >
          <ClockGlyph />
          {post.scheduledAt}
        </span>
      </header>
      <div style={{ padding: "22px 24px 14px" }}>
        <p
          style={{
            margin: 0,
            fontSize: 24,
            lineHeight: 1.45,
            letterSpacing: "-0.374px",
            color: "var(--sf-fg-1)",
            whiteSpace: "pre-wrap",
          }}
        >
          {post.draftBody}
        </p>
      </div>
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
            background: "var(--sf-accent)",
            color: "#fff",
            fontFamily: "var(--sf-font-text)",
            fontSize: 18,
            fontWeight: 500,
            cursor: "default",
          }}
        >
          Schedule
        </button>
        <span
          style={{
            padding: "10px 14px",
            fontSize: 16,
            color: "var(--sf-fg-2)",
          }}
        >
          Edit
        </span>
        <span
          style={{
            padding: "10px 14px",
            fontSize: 16,
            color: "var(--sf-fg-2)",
          }}
        >
          Skip
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: "var(--sf-font-mono)",
            fontSize: 15,
            color: len > post.charCap ? "var(--sf-error)" : "var(--sf-fg-3)",
            letterSpacing: "-0.12px",
          }}
        >
          {len} / {post.charCap}
        </span>
      </div>
    </article>
  );
};

const ClockGlyph: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.25" />
    <path
      d="M6 3.5V6l1.5 1.5"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
    />
  </svg>
);
