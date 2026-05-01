interface CursorProps {
  x: number;
  y: number;
  /** 0–1, 1 = clicked (small ripple) */
  click?: number;
}

export const Cursor: React.FC<CursorProps> = ({ x, y, click = 0 }) => (
  <div
    style={{
      position: "absolute",
      top: y,
      left: x,
      pointerEvents: "none",
      zIndex: 100,
    }}
  >
    {click > 0 ? (
      <span
        style={{
          position: "absolute",
          left: -18,
          top: -18,
          width: 36,
          height: 36,
          borderRadius: "50%",
          border: "2px solid var(--sf-accent)",
          opacity: 1 - click,
          transform: `scale(${0.4 + click * 0.8})`,
        }}
      />
    ) : null}
    <svg
      width="28"
      height="28"
      viewBox="0 0 28 28"
      style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.3))" }}
    >
      <path
        d="M5 3 L5 22 L10 17 L13 23 L16 22 L13 16 L20 16 Z"
        fill="#fff"
        stroke="#000"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  </div>
);
