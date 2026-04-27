import type { CSSProperties, ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Shared renderer for LLM-authored chat text. `react-markdown` parses
 * the string server-safe (no raw HTML rendering — `<script>` in agent
 * output stays a literal string), and we override each tag with inline
 * styles that track the app's `--sf-*` tokens so light / dark stay
 * consistent without a stylesheet dependency.
 *
 * Kept tight: supports the subset agents actually produce (headings up
 * to h4, bold / italic / code / links, bullet + ordered lists,
 * blockquotes, fenced code). GFM is enabled for tables + autolinks +
 * strikethrough.
 */
export function MessageMarkdown({
  text,
  trailing,
}: {
  text: string;
  /** Inline content to append after the last block (used for the
   * streaming dots on partial messages). */
  trailing?: ReactNode;
}) {
  return (
    <div style={wrap}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
      {trailing ? <span style={trailingWrap}>{trailing}</span> : null}
    </div>
  );
}

const wrap: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.55,
  color: 'var(--sf-fg-1)',
  letterSpacing: '-0.01em',
  wordBreak: 'break-word',
};

const trailingWrap: CSSProperties = {
  display: 'inline-flex',
  marginLeft: 6,
};

const h1: CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  lineHeight: 1.3,
  margin: '14px 0 6px',
  letterSpacing: '-0.015em',
  color: 'var(--sf-fg-1)',
};
const h2: CSSProperties = { ...h1, fontSize: 16 };
const h3: CSSProperties = { ...h1, fontSize: 14.5, fontWeight: 600 };
const h4: CSSProperties = { ...h1, fontSize: 13.5, fontWeight: 600 };

const paragraph: CSSProperties = {
  margin: '0 0 10px',
};

const listStyle: CSSProperties = {
  margin: '0 0 10px',
  paddingLeft: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
};

const listItem: CSSProperties = {
  margin: 0,
  paddingLeft: 2,
};

const inlineCode: CSSProperties = {
  fontFamily: 'var(--sf-font-mono)',
  fontSize: '0.88em',
  padding: '1px 5px',
  borderRadius: 4,
  background: 'rgba(0, 0, 0, 0.05)',
  color: 'var(--sf-fg-1)',
  wordBreak: 'break-all',
};

const codeBlock: CSSProperties = {
  margin: '0 0 10px',
  padding: '10px 12px',
  borderRadius: 8,
  background: 'rgba(0, 0, 0, 0.04)',
  border: '1px solid rgba(0, 0, 0, 0.06)',
  fontFamily: 'var(--sf-font-mono)',
  fontSize: 12.5,
  lineHeight: 1.45,
  overflowX: 'auto',
  color: 'var(--sf-fg-1)',
};

const blockquote: CSSProperties = {
  margin: '0 0 10px',
  padding: '2px 0 2px 12px',
  borderLeft: '3px solid rgba(0, 0, 0, 0.12)',
  color: 'var(--sf-fg-2)',
};

const link: CSSProperties = {
  color: 'var(--sf-accent, #0071e3)',
  textDecoration: 'underline',
  textDecorationThickness: 1,
  textUnderlineOffset: 2,
};

const strong: CSSProperties = { fontWeight: 600, color: 'var(--sf-fg-1)' };
const em: CSSProperties = { fontStyle: 'italic' };

const hr: CSSProperties = {
  border: 'none',
  borderTop: '1px solid rgba(0, 0, 0, 0.08)',
  margin: '12px 0',
};

/**
 * Flatten markdown to a single clean line for truncated previews
 * (collapsed subtask cards). Drops block markers (`## `, `- `, fences)
 * and emphasis (`**`, `*`, `_`, backticks) without touching the actual
 * word content. NOT a sanitizer — run only on trusted already-in-DB
 * agent output that you would otherwise show raw.
 */
export function stripMarkdownForPreview(text: string): string {
  let out = text
    // Fenced code blocks → keep inner text
    .replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, '$1')
    // Images → alt text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Links → link text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Leading heading / quote / list markers on a line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    // Bold / italic (run twice so **_x_** → x)
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    // Inline code
    .replace(/`([^`]+)`/g, '$1')
    // Horizontal rules
    .replace(/^\s*[-*_]{3,}\s*$/gm, '');
  // Collapse any run of whitespace (incl. newlines) to a single space.
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

const components: Components = {
  h1: ({ children }) => <h1 style={h1}>{children}</h1>,
  h2: ({ children }) => <h2 style={h2}>{children}</h2>,
  h3: ({ children }) => <h3 style={h3}>{children}</h3>,
  h4: ({ children }) => <h4 style={h4}>{children}</h4>,
  h5: ({ children }) => <h5 style={h4}>{children}</h5>,
  h6: ({ children }) => <h6 style={h4}>{children}</h6>,
  p: ({ children }) => <p style={paragraph}>{children}</p>,
  ul: ({ children }) => <ul style={listStyle}>{children}</ul>,
  ol: ({ children }) => <ol style={listStyle}>{children}</ol>,
  li: ({ children }) => <li style={listItem}>{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      style={link}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong style={strong}>{children}</strong>,
  em: ({ children }) => <em style={em}>{children}</em>,
  code: ({ children, className }) => {
    // `react-markdown` hands fenced blocks as a `<code class="language-xxx">`
    // inside a `<pre>` (we style pre below); bare inline code arrives with
    // no className. Split the two so inline stays tight and blocks get
    // their own padding + scroll area.
    const isFenced = typeof className === 'string' && className.startsWith('language-');
    if (isFenced) {
      return <code style={{ fontFamily: 'inherit' }}>{children}</code>;
    }
    return <code style={inlineCode}>{children}</code>;
  },
  pre: ({ children }) => <pre style={codeBlock}>{children}</pre>,
  blockquote: ({ children }) => <blockquote style={blockquote}>{children}</blockquote>,
  hr: () => <hr style={hr} />,
};
