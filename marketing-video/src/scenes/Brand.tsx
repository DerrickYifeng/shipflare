import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { BRAND_EASE } from "../lib/easing";
import { RadialGlow } from "../components/RadialGlow";

export const Brand: React.FC = () => {
  const frame = useCurrentFrame();

  // Logo scales 2.5 → 1 over 24 frames
  const logoScale = interpolate(frame, [0, 24], [2.5, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const logoOpacity = interpolate(frame, [0, 18], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const wordmark = interpolate(frame, [22, 40], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const tagline = interpolate(frame, [32, 50], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Glow expands as logo settles
  const glow = interpolate(frame, [10, 40], [0, 0.55], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: "var(--sf-bg-dark)",
        alignItems: "center",
        justifyContent: "center",
        padding: "150px 60px 170px",
      }}
    >
      <RadialGlow size={1.4} intensity={glow} top={780} />
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 48,
        }}
      >
        <Img
          src={staticFile("logo.png")}
          style={{
            width: 240,
            height: 240,
            opacity: logoOpacity,
            transform: `scale(${logoScale})`,
          }}
        />
        <div
          style={{
            opacity: wordmark,
            transform: `translateY(${interpolate(wordmark, [0, 1], [16, 0])}px)`,
            fontFamily: "var(--sf-font-display)",
            fontSize: 112,
            fontWeight: 600,
            lineHeight: 1.05,
            letterSpacing: "-0.56px",
            color: "var(--sf-fg-on-dark-1)",
          }}
        >
          ShipFlare
        </div>
        <div
          style={{
            opacity: tagline,
            transform: `translateY(${interpolate(tagline, [0, 1], [12, 0])}px)`,
            fontFamily: "var(--sf-font-text)",
            fontSize: 44,
            lineHeight: 1.3,
            letterSpacing: "-0.4px",
            color: "var(--sf-fg-on-dark-2)",
            textAlign: "center",
            maxWidth: 880,
          }}
        >
          The AI marketing team for solo founders.
        </div>
      </div>
    </AbsoluteFill>
  );
};
