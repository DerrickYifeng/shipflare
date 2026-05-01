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
      }}
    >
      <RadialGlow size={0.9} intensity={glow} top={540} />
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 64,
        }}
      >
        <Img
          src={staticFile("logo.png")}
          style={{
            width: 280,
            height: 280,
            opacity: logoOpacity,
            transform: `scale(${logoScale})`,
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              opacity: wordmark,
              transform: `translateX(${interpolate(wordmark, [0, 1], [16, 0])}px)`,
              fontFamily: "var(--sf-font-display)",
              fontSize: 144,
              fontWeight: 600,
              lineHeight: 1,
              letterSpacing: "-0.72px",
              color: "var(--sf-fg-on-dark-1)",
            }}
          >
            ShipFlare
          </div>
          <div
            style={{
              opacity: tagline,
              transform: `translateX(${interpolate(tagline, [0, 1], [12, 0])}px)`,
              fontFamily: "var(--sf-font-text)",
              fontSize: 40,
              lineHeight: 1.3,
              letterSpacing: "-0.4px",
              color: "var(--sf-fg-on-dark-2)",
              maxWidth: 900,
            }}
          >
            The AI marketing team for solo founders.
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
