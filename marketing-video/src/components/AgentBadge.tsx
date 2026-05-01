interface AgentBadgeProps {
  role: string;
  caption?: string;
  opacity?: number;
}

export const AgentBadge: React.FC<AgentBadgeProps> = ({
  role,
  caption,
  opacity = 1,
}) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 14,
      padding: "14px 22px",
      background: "rgba(255,255,255,0.06)",
      border: "1px solid rgba(255,255,255,0.12)",
      borderRadius: 999,
      opacity,
    }}
  >
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: "var(--sf-success)",
        boxShadow: "0 0 16px var(--sf-success)",
      }}
    />
    <span
      style={{
        fontFamily: "var(--sf-font-mono)",
        fontSize: 26,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "-0.12px",
        color: "var(--sf-fg-on-dark-1)",
      }}
    >
      {role}
    </span>
    {caption ? (
      <span
        style={{
          fontFamily: "var(--sf-font-text)",
          fontSize: 24,
          color: "var(--sf-fg-on-dark-3)",
          letterSpacing: "-0.224px",
        }}
      >
        · {caption}
      </span>
    ) : null}
  </div>
);
