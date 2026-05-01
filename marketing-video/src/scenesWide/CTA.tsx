import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { BRAND_EASE } from "../lib/easing";
import { LiveTicker } from "../components/LiveTicker";
import { RadialGlow } from "../components/RadialGlow";
import { GlobeIcon } from "../components/MethodIcons";

const FEATURE_CHIPS = ["Finds threads", "Drafts in your voice", "You approve"];

export const CTA: React.FC = () => {
  const frame = useCurrentFrame();

  const headEnter = interpolate(frame, [0, 20], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const sfEnter = interpolate(frame, [22, 42], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const plusEnter = interpolate(frame, [38, 56], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const productEnter = interpolate(frame, [50, 70], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const eqEnter = interpolate(frame, [68, 86], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const statEnter = interpolate(frame, [82, 110], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const ctaEnter = interpolate(frame, [105, 130], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const pulse = 1 + 0.018 * Math.sin((frame - 110) * 0.12);

  return (
    <AbsoluteFill style={{ background: "var(--sf-bg-dark)" }}>
      <RadialGlow size={0.8} intensity={headEnter * 0.35} top={540} />

      {/* Top: Headline + chips */}
      <div
        style={{
          position: "absolute",
          top: 100,
          left: 80,
          right: 80,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 24,
          opacity: headEnter,
          transform: `translateY(${interpolate(headEnter, [0, 1], [12, 0])}px)`,
        }}
      >
        <div
          style={{
            fontFamily: "var(--sf-font-display)",
            fontSize: 84,
            fontWeight: 600,
            lineHeight: 1.05,
            letterSpacing: "-0.42px",
            color: "var(--sf-fg-on-dark-1)",
            textAlign: "center",
          }}
        >
          Your private AI marketing team.
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          {FEATURE_CHIPS.map((chip, i) => {
            const chipStart = 18 + i * 6;
            const chipOp = interpolate(
              frame,
              [chipStart, chipStart + 18],
              [0, 1],
              {
                easing: BRAND_EASE,
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              },
            );
            return (
              <span
                key={chip}
                style={{
                  opacity: chipOp,
                  padding: "8px 16px",
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.08)",
                  border: "1px solid rgba(255,255,255,0.12)",
                  color: "var(--sf-fg-on-dark-2)",
                  fontFamily: "var(--sf-font-mono)",
                  fontSize: 18,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "-0.12px",
                }}
              >
                {chip}
              </span>
            );
          })}
        </div>
      </div>

      {/* Middle: Equation horizontal — [ShipFlare] + [your product] = stat */}
      <div
        style={{
          position: "absolute",
          top: 380,
          left: 80,
          right: 80,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 32,
        }}
      >
        {/* ShipFlare pill */}
        <div
          style={{
            opacity: sfEnter,
            transform: `translateY(${interpolate(sfEnter, [0, 1], [12, 0])}px)`,
            display: "inline-flex",
            alignItems: "center",
            gap: 16,
            padding: "18px 28px",
            background: "var(--sf-bg-secondary)",
            borderRadius: 999,
            boxShadow: "0 12px 40px rgba(0,113,227,0.25)",
          }}
        >
          <Img src={staticFile("logo.png")} style={{ width: 52, height: 52 }} />
          <span
            style={{
              fontFamily: "var(--sf-font-display)",
              fontSize: 38,
              fontWeight: 600,
              letterSpacing: "-0.32px",
              color: "var(--sf-fg-1)",
            }}
          >
            ShipFlare
          </span>
        </div>

        <div
          style={{
            opacity: plusEnter,
            fontFamily: "var(--sf-font-display)",
            fontSize: 56,
            fontWeight: 400,
            color: "var(--sf-fg-on-dark-3)",
            lineHeight: 1,
          }}
        >
          +
        </div>

        <div
          style={{
            opacity: productEnter,
            transform: `translateY(${interpolate(productEnter, [0, 1], [12, 0])}px)`,
            display: "inline-flex",
            alignItems: "center",
            gap: 14,
            padding: "18px 28px",
            background: "var(--sf-bg-secondary)",
            borderRadius: 999,
          }}
        >
          <GlobeIcon size={32} color="var(--sf-accent)" />
          <span
            style={{
              fontFamily: "var(--sf-font-mono)",
              fontSize: 32,
              fontWeight: 600,
              letterSpacing: "-0.12px",
              color: "var(--sf-fg-1)",
            }}
          >
            your product
          </span>
        </div>

        <div
          style={{
            opacity: eqEnter,
            fontFamily: "var(--sf-font-display)",
            fontSize: 48,
            fontWeight: 400,
            color: "var(--sf-fg-on-dark-3)",
            lineHeight: 1,
          }}
        >
          =
        </div>

        {/* Stat block */}
        <div
          style={{
            opacity: statEnter,
            transform: `translateY(${interpolate(statEnter, [0, 1], [16, 0])}px)`,
            textAlign: "center",
          }}
        >
          <LiveTicker
            startFrame={82}
            base={184}
            tickPerSecond={14}
            initialFrames={24}
            prefix="+"
            style={{
              fontFamily: "var(--sf-font-mono)",
              fontSize: 110,
              fontWeight: 600,
              lineHeight: 1,
              letterSpacing: "-0.4px",
              color: "var(--sf-success)",
              fontVariantNumeric: "tabular-nums",
            }}
          />
          <div
            style={{
              marginTop: 8,
              fontFamily: "var(--sf-font-text)",
              fontSize: 26,
              fontWeight: 500,
              color: "var(--sf-fg-on-dark-1)",
              letterSpacing: "-0.32px",
            }}
          >
            new customers · last 30 days
          </div>
          <div
            style={{
              marginTop: 4,
              fontFamily: "var(--sf-font-mono)",
              fontSize: 22,
              fontWeight: 600,
              color: "var(--sf-link-dark)",
              letterSpacing: "-0.12px",
            }}
          >
            +$
            <LiveTicker
              startFrame={92}
              base={14}
              tickPerSecond={1}
              initialFrames={28}
              suffix="k MRR"
              style={{
                fontFamily: "var(--sf-font-mono)",
                fontVariantNumeric: "tabular-nums",
              }}
            />
          </div>
        </div>
      </div>

      {/* shipflare.ai — close to the stat block (visually anchored, not at edge) */}
      <div
        style={{
          position: "absolute",
          top: 760,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          opacity: ctaEnter,
          transform: `translateY(${interpolate(ctaEnter, [0, 1], [16, 0])}px)`,
        }}
      >
        <div
          style={{
            transform: `scale(${pulse})`,
            fontFamily: "var(--sf-font-display)",
            fontSize: 56,
            fontWeight: 600,
            lineHeight: 1.05,
            letterSpacing: "-0.28px",
            color: "var(--sf-link-dark)",
          }}
        >
          shipflare.ai
        </div>
      </div>
    </AbsoluteFill>
  );
};
