import type { CSSProperties, ReactNode } from "react";

interface AppChromeProps {
  url: string;
  children: ReactNode;
  /** Optional small label inside the title bar (e.g. "today") */
  tab?: string;
  width?: number;
  bodyStyle?: CSSProperties;
}

export const AppChrome: React.FC<AppChromeProps> = ({
  url,
  children,
  tab,
  width = 1600,
  bodyStyle,
}) => (
  <div
    style={{
      width,
      borderRadius: 18,
      overflow: "hidden",
      background: "var(--sf-bg-secondary)",
      boxShadow: "0 30px 80px rgba(0,0,0,0.18), 0 8px 24px rgba(0,0,0,0.06)",
      border: "1px solid rgba(0,0,0,0.08)",
      fontFamily: "var(--sf-font-text)",
    }}
  >
    {/* Title bar */}
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "14px 18px",
        background: "rgba(0,0,0,0.04)",
        borderBottom: "1px solid rgba(0,0,0,0.06)",
      }}
    >
      <Dot color="#ff5f57" />
      <Dot color="#febc2e" />
      <Dot color="#28c840" />
      <div
        style={{
          marginLeft: 18,
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 18px",
            borderRadius: 10,
            background: "var(--sf-bg-secondary)",
            border: "1px solid rgba(0,0,0,0.08)",
            fontFamily: "var(--sf-font-mono)",
            fontSize: 16,
            color: "var(--sf-fg-2)",
            letterSpacing: "-0.12px",
            minWidth: 520,
            justifyContent: "center",
          }}
        >
          <LockGlyph />
          {url}
        </div>
      </div>
      {tab ? (
        <span
          style={{
            fontFamily: "var(--sf-font-mono)",
            fontSize: 13,
            textTransform: "uppercase",
            letterSpacing: "-0.12px",
            color: "var(--sf-fg-3)",
          }}
        >
          {tab}
        </span>
      ) : null}
    </div>
    <div style={bodyStyle}>{children}</div>
  </div>
);

const Dot: React.FC<{ color: string }> = ({ color }) => (
  <span
    style={{
      width: 14,
      height: 14,
      borderRadius: "50%",
      background: color,
      display: "inline-block",
    }}
  />
);

const LockGlyph: React.FC = () => (
  <svg width="11" height="13" viewBox="0 0 12 14" fill="none">
    <rect
      x="2"
      y="6"
      width="8"
      height="6.5"
      rx="1.5"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <path d="M4 6V4a2 2 0 014 0v2" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);
