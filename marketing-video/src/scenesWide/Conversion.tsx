import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { BRAND_EASE } from "../lib/easing";
import { LiveTicker } from "../components/LiveTicker";

const ENGAGEMENT_FIRST = 30;
const ENGAGEMENT_GAP = 32;

const ENGAGEMENT = [
  { base: 1247, tickPerSecond: 32, label: "Likes" },
  { base: 389, tickPerSecond: 11, label: "Views" },
  { base: 47, tickPerSecond: 2.4, label: "DMs" },
  { base: 12, tickPerSecond: 1.6, label: "Customers" },
];

const SIGNUP_LANDED =
  ENGAGEMENT_FIRST + (ENGAGEMENT.length - 1) * ENGAGEMENT_GAP + 22;

export const Conversion: React.FC = () => {
  const frame = useCurrentFrame();

  const headEnter = interpolate(frame, [0, 18], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const signupPulse = 1 + 0.025 * Math.sin((frame - SIGNUP_LANDED) * 0.08);
  const pulseActive = frame > SIGNUP_LANDED;
  const signupGlow = interpolate(
    frame,
    [SIGNUP_LANDED - 6, SIGNUP_LANDED + 18],
    [0, 1],
    { easing: BRAND_EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ background: "var(--sf-bg-dark)" }}>
      {/* Title block — anchored top */}
      <div
        style={{
          position: "absolute",
          top: 120,
          left: 80,
          right: 80,
          opacity: headEnter,
          transform: `translateY(${interpolate(headEnter, [0, 1], [-12, 0])}px)`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
          textAlign: "center",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 20px",
            background: "rgba(52,199,89,0.14)",
            border: "1px solid rgba(52,199,89,0.32)",
            borderRadius: 999,
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "var(--sf-success)",
            }}
          />
          <span
            style={{
              fontFamily: "var(--sf-font-mono)",
              fontSize: 18,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "-0.12px",
              color: "var(--sf-success)",
            }}
          >
            Reply sent · live counters
          </span>
        </div>
        <h2
          style={{
            margin: 0,
            fontFamily: "var(--sf-font-display)",
            fontSize: 88,
            fontWeight: 600,
            lineHeight: 1.05,
            letterSpacing: "-0.44px",
            color: "var(--sf-fg-on-dark-1)",
          }}
        >
          Then this happens.
        </h2>
      </div>

      {/* 4 ticker rows — centered horizontally below title */}
      <div
        style={{
          position: "absolute",
          top: 400,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: 1000,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {ENGAGEMENT.map((row, i) => {
            const start = ENGAGEMENT_FIRST + i * ENGAGEMENT_GAP;
            const op = interpolate(frame, [start, start + 22], [0, 1], {
              easing: BRAND_EASE,
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            const tx = interpolate(op, [0, 1], [40, 0]);
            const isSignup = i === ENGAGEMENT.length - 1;
            return (
              <div
                key={row.label}
                style={{
                  opacity: op,
                  transform: `translateX(${tx}px) ${isSignup && pulseActive ? `scale(${signupPulse})` : ""}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 24,
                  padding: "20px 28px",
                  background: isSignup
                    ? "rgba(52,199,89,0.16)"
                    : "rgba(255,255,255,0.04)",
                  border: isSignup
                    ? "1px solid rgba(52,199,89,0.4)"
                    : "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 18,
                  boxShadow: isSignup
                    ? `0 0 ${48 * signupGlow}px rgba(52,199,89,${0.45 * signupGlow})`
                    : "none",
                }}
              >
                <LiveTicker
                  startFrame={start + 8}
                  base={row.base}
                  tickPerSecond={row.tickPerSecond}
                  prefix="+"
                  style={{
                    fontFamily: "var(--sf-font-mono)",
                    fontSize: 44,
                    fontWeight: 700,
                    color: isSignup
                      ? "var(--sf-success)"
                      : "var(--sf-link-dark)",
                    letterSpacing: "-0.4px",
                    minWidth: 220,
                    fontVariantNumeric: "tabular-nums",
                  }}
                />
                <span
                  style={{
                    fontFamily: "var(--sf-font-text)",
                    fontSize: 30,
                    color: "var(--sf-fg-on-dark-1)",
                    letterSpacing: "-0.32px",
                    lineHeight: 1.25,
                    flex: 1,
                  }}
                >
                  {row.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
