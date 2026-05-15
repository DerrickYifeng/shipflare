"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CSSProperties } from "react";

interface MessageMarkdownProps {
  /** Markdown source (may be empty during streaming). */
  source: string;
  /** Pass true to render inverted colors on dark CTA / user bubbles. */
  onDark?: boolean;
}

const linkStyle = (onDark: boolean): CSSProperties => ({
  color: onDark ? "var(--sf-link-dark)" : "var(--sf-link)",
  textDecoration: "underline",
  textUnderlineOffset: 2,
});

const codeStyle = (onDark: boolean): CSSProperties => ({
  fontFamily: "var(--sf-font-mono)",
  fontSize: "0.92em",
  background: onDark ? "rgba(255,255,255,0.12)" : "var(--sf-bg-tertiary)",
  color: onDark ? "var(--sf-fg-on-dark-1)" : "var(--sf-fg-1)",
  padding: "1px 5px",
  borderRadius: 4,
});

const preStyle = (onDark: boolean): CSSProperties => ({
  margin: "8px 0",
  padding: "10px 12px",
  background: onDark ? "rgba(0,0,0,0.28)" : "var(--sf-bg-tertiary)",
  color: onDark ? "var(--sf-fg-on-dark-1)" : "var(--sf-fg-1)",
  borderRadius: 8,
  overflowX: "auto",
  fontSize: 12.5,
  lineHeight: 1.55,
});

const ulStyle: CSSProperties = {
  margin: "6px 0",
  paddingLeft: 22,
};

const liStyle: CSSProperties = {
  marginBottom: 2,
};

const blockquoteStyle = (onDark: boolean): CSSProperties => ({
  margin: "6px 0",
  paddingLeft: 12,
  borderLeft: `3px solid ${onDark ? "rgba(255,255,255,0.32)" : "var(--sf-border-strong)"}`,
  color: onDark ? "var(--sf-fg-on-dark-2)" : "var(--sf-fg-2)",
});

/**
 * MessageMarkdown — render a chat message body as markdown.
 *
 * Ported from Railway's message-markdown.tsx. CF version omits the
 * syntax highlighter (rehype-highlight is heavy) and uses inline styles
 * to keep with the rest of the team page styling.
 */
export function MessageMarkdown({ source, onDark = false }: MessageMarkdownProps) {
  return (
    <div style={{ wordBreak: "break-word" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p style={{ margin: "4px 0", lineHeight: 1.55 }}>{children}</p>
          ),
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" style={linkStyle(onDark)}>
              {children}
            </a>
          ),
          code: ({ children, ...rest }) => {
            const isInline = !("className" in rest && typeof rest.className === "string" && rest.className.startsWith("language-"));
            return isInline ? (
              <code style={codeStyle(onDark)}>{children}</code>
            ) : (
              <code style={{ fontFamily: "var(--sf-font-mono)" }}>{children}</code>
            );
          },
          pre: ({ children }) => <pre style={preStyle(onDark)}>{children}</pre>,
          ul: ({ children }) => <ul style={ulStyle}>{children}</ul>,
          ol: ({ children }) => <ol style={ulStyle}>{children}</ol>,
          li: ({ children }) => <li style={liStyle}>{children}</li>,
          blockquote: ({ children }) => (
            <blockquote style={blockquoteStyle(onDark)}>{children}</blockquote>
          ),
          h1: ({ children }) => (
            <h1 style={{ fontSize: 18, fontWeight: 600, margin: "8px 0 4px" }}>{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: "8px 0 4px" }}>{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: "6px 0 4px" }}>{children}</h3>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
