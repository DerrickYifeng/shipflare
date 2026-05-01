interface RadialGlowProps {
  /** Glow size as fraction of viewport (0–1) */
  size?: number;
  /** Color (with alpha) at center */
  color?: string;
  /** 0–1 intensity multiplier */
  intensity?: number;
  /** Position from top, in px */
  top?: number;
}

export const RadialGlow: React.FC<RadialGlowProps> = ({
  size = 0.8,
  color = "rgba(0, 113, 227, 0.45)",
  intensity = 1,
  top = 960,
}) => (
  <div
    aria-hidden
    style={{
      position: "absolute",
      top,
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: 1080 * size,
      height: 1080 * size,
      borderRadius: "50%",
      background: `radial-gradient(circle, ${color} 0%, transparent 60%)`,
      opacity: intensity,
      pointerEvents: "none",
      filter: "blur(40px)",
    }}
  />
);
