import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { BRAND_EASE } from "../lib/easing";
import { AgentBadge } from "../components/AgentBadge";
import { CountUp } from "../components/CountUp";
import { HITS } from "../lib/data";

const HIT_FIRST = 36;
const HIT_GAP = 42;

export const Discovery: React.FC = () => {
  const frame = useCurrentFrame();

  const headEnter = interpolate(frame, [0, 18], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

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
        <AgentBadge role="Social Agent" caption="scanning X" />
        <h2
          style={{
            margin: 0,
            fontFamily: "var(--sf-font-display)",
            fontSize: 80,
            fontWeight: 600,
            lineHeight: 1.05,
            letterSpacing: "-0.4px",
            color: "var(--sf-fg-on-dark-1)",
          }}
        >
          Found 3 potential users talking right now.
        </h2>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 14,
            fontFamily: "var(--sf-font-mono)",
            fontSize: 22,
            color: "var(--sf-fg-on-dark-3)",
            letterSpacing: "-0.12px",
          }}
        >
          <CountUp
            to={1284}
            startFrame={6}
            durationFrames={42}
            style={{ color: "var(--sf-link-dark)", fontWeight: 600 }}
          />
          <span>threads scanned · 3 high-intent matches</span>
        </div>
      </div>

      {/* 3 thread cards — centered horizontally below title */}
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
            width: 1280,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {HITS.map((hit, i) => {
            const start = HIT_FIRST + i * HIT_GAP;
            const op = interpolate(frame, [start, start + 22], [0, 1], {
              easing: BRAND_EASE,
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            const ty = interpolate(op, [0, 1], [22, 0]);
            return (
              <div
                key={hit.authorHandle}
                style={{
                  opacity: op,
                  transform: `translateY(${ty}px)`,
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 18,
                  padding: "20px 24px",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 18,
                }}
              >
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: "50%",
                    background: "#000",
                    color: "#fff",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "var(--sf-font-display)",
                    fontSize: 24,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  𝕏
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 12,
                      marginBottom: 8,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 24,
                        fontWeight: 600,
                        color: "var(--sf-fg-on-dark-1)",
                        letterSpacing: "-0.32px",
                      }}
                    >
                      {hit.authorHandle}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--sf-font-mono)",
                        fontSize: 18,
                        color: "var(--sf-fg-on-dark-3)",
                        letterSpacing: "-0.12px",
                      }}
                    >
                      · {hit.postedRelative}
                    </span>
                    <span
                      style={{
                        marginLeft: "auto",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "3px 10px",
                        borderRadius: 999,
                        background: "rgba(255,159,10,0.14)",
                        border: "1px solid rgba(255,159,10,0.32)",
                        color: "var(--sf-warning)",
                        fontFamily: "var(--sf-font-mono)",
                        fontSize: 14,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "-0.12px",
                      }}
                    >
                      🔥 painpoint
                    </span>
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--sf-font-text)",
                      fontSize: 22,
                      lineHeight: 1.35,
                      letterSpacing: "-0.224px",
                      color: "var(--sf-fg-on-dark-1)",
                    }}
                  >
                    {hit.snippet}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
