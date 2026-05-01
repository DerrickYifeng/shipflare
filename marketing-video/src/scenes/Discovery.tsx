import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { BRAND_EASE } from "../lib/easing";
import { AgentBadge } from "../components/AgentBadge";
import { CountUp } from "../components/CountUp";
import { HITS } from "../lib/data";

// 210f / 7s — each thread fully visible for ~1.5s minimum

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
    <AbsoluteFill
      style={{
        background: "var(--sf-bg-dark)",
        padding: "150px 60px 170px",
        flexDirection: "column",
        gap: 30,
      }}
    >
      <div
        style={{
          opacity: headEnter,
          transform: `translateY(${interpolate(headEnter, [0, 1], [12, 0])}px)`,
          display: "flex",
          flexDirection: "column",
          gap: 22,
        }}
      >
        <AgentBadge role="Social Agent" caption="scanning X" />
        <h2
          style={{
            margin: 0,
            fontFamily: "var(--sf-font-display)",
            fontSize: 60,
            fontWeight: 600,
            lineHeight: 1.05,
            letterSpacing: "-0.32px",
            color: "var(--sf-fg-on-dark-1)",
          }}
        >
          Found 3 potential users <br />
          talking right now.
        </h2>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 16,
            fontFamily: "var(--sf-font-mono)",
            fontSize: 24,
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

      <div
        style={{
          marginTop: 8,
          display: "flex",
          flexDirection: "column",
          gap: 20,
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
            <ThreadHitCard
              key={hit.authorHandle}
              opacity={op}
              translateY={ty}
              handle={hit.authorHandle}
              snippet={hit.snippet}
              when={hit.postedRelative}
            />
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

interface ThreadHitCardProps {
  opacity: number;
  translateY: number;
  handle: string;
  snippet: string;
  when: string;
}

const ThreadHitCard: React.FC<ThreadHitCardProps> = ({
  opacity,
  translateY,
  handle,
  snippet,
  when,
}) => (
  <div
    style={{
      opacity,
      transform: `translateY(${translateY}px)`,
      display: "flex",
      alignItems: "flex-start",
      gap: 20,
      padding: "22px 26px",
      background: "rgba(255,255,255,0.04)",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: 18,
    }}
  >
    <div
      style={{
        width: 52,
        height: 52,
        borderRadius: "50%",
        background: "#000",
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--sf-font-display)",
        fontSize: 26,
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
          marginBottom: 10,
        }}
      >
        <span
          style={{
            fontSize: 26,
            fontWeight: 600,
            color: "var(--sf-fg-on-dark-1)",
            letterSpacing: "-0.32px",
          }}
        >
          {handle}
        </span>
        <span
          style={{
            fontFamily: "var(--sf-font-mono)",
            fontSize: 20,
            color: "var(--sf-fg-on-dark-3)",
            letterSpacing: "-0.12px",
          }}
        >
          · {when}
        </span>
        <span
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            borderRadius: 999,
            background: "rgba(255,159,10,0.14)",
            border: "1px solid rgba(255,159,10,0.32)",
            color: "var(--sf-warning)",
            fontFamily: "var(--sf-font-mono)",
            fontSize: 16,
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
          fontSize: 26,
          lineHeight: 1.35,
          letterSpacing: "-0.224px",
          color: "var(--sf-fg-on-dark-1)",
        }}
      >
        {snippet}
      </div>
    </div>
  </div>
);
