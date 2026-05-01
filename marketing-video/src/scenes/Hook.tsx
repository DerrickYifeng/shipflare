import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { BRAND_EASE } from "../lib/easing";
import { RadialGlow } from "../components/RadialGlow";

export const Hook: React.FC = () => {
  const frame = useCurrentFrame();

  const logoEnter = interpolate(frame, [0, 18], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const line1 = interpolate(frame, [10, 28], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const line2 = interpolate(frame, [22, 40], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Soft Apple Blue glow breathes in: 0 → 1 over 30f, then holds
  const glow = interpolate(frame, [0, 30], [0, 1], {
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
      <RadialGlow size={1.6} intensity={glow * 0.7} top={960} />
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 56,
        }}
      >
        <Img
          src={staticFile("logo.png")}
          style={{
            width: 140,
            height: 140,
            opacity: logoEnter,
            transform: `translateY(${interpolate(logoEnter, [0, 1], [16, 0])}px)`,
          }}
        />
        <div
          style={{
            textAlign: "center",
            fontFamily: "var(--sf-font-display)",
            fontSize: 128,
            fontWeight: 600,
            lineHeight: 1.05,
            letterSpacing: "-0.64px",
            color: "var(--sf-fg-on-dark-1)",
          }}
        >
          <div
            style={{
              opacity: line1,
              transform: `translateY(${interpolate(line1, [0, 1], [20, 0])}px)`,
            }}
          >
            You ship.
          </div>
          <div
            style={{
              opacity: line2,
              transform: `translateY(${interpolate(line2, [0, 1], [20, 0])}px)`,
              color: "var(--sf-link-dark)",
            }}
          >
            We get you seen.
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
