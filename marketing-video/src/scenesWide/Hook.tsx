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
      }}
    >
      <RadialGlow size={1.2} intensity={glow * 0.6} top={540} />
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
            width: 180,
            height: 180,
            opacity: logoEnter,
            transform: `translateX(${interpolate(logoEnter, [0, 1], [-16, 0])}px)`,
          }}
        />
        <div
          style={{
            fontFamily: "var(--sf-font-display)",
            fontSize: 156,
            fontWeight: 600,
            lineHeight: 1.05,
            letterSpacing: "-0.78px",
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
