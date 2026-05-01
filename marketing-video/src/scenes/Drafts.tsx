import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { BRAND_EASE } from "../lib/easing";
import { ReplyCard } from "../components/ReplyCard";
import { PostCard } from "../components/PostCard";
import { AgentBadge } from "../components/AgentBadge";
import { POST, REPLY } from "../lib/data";

// 180f / 6s — Reply (3s) → Post (3s) crossfade
const REPLY_END = 90;
const REPLY_FADE_OUT = 100;
const POST_FADE_IN = 96;

export const Drafts: React.FC = () => {
  const frame = useCurrentFrame();

  const replyOp = interpolate(
    frame,
    [0, 18, REPLY_END, REPLY_FADE_OUT + 14],
    [0, 1, 1, 0],
    { easing: BRAND_EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const postOp = interpolate(frame, [POST_FADE_IN, POST_FADE_IN + 18], [0, 1], {
    easing: BRAND_EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: "var(--sf-bg-dark)",
        padding: "150px 60px 170px",
      }}
    >
      {/* Phase 1 — Social Agent drafts the reply */}
      {replyOp > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            padding: "150px 60px 170px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 40,
            opacity: replyOp,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 22,
            }}
          >
            <AgentBadge role="Social Agent" caption="real prospects" />
            <h2
              style={{
                margin: 0,
                fontFamily: "var(--sf-font-display)",
                fontSize: 64,
                fontWeight: 600,
                lineHeight: 1.05,
                letterSpacing: "-0.32px",
                color: "var(--sf-fg-on-dark-1)",
              }}
            >
              Reply to real <br />
              potential customers.
            </h2>
          </div>
          <ReplyCard reply={REPLY} />
        </div>
      ) : null}

      {/* Phase 2 — Content Agent drafts the build-in-public post */}
      {postOp > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            padding: "150px 60px 170px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 40,
            opacity: postOp,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 22,
            }}
          >
            <AgentBadge role="Content Agent" caption="phase-aligned" />
            <h2
              style={{
                margin: 0,
                fontFamily: "var(--sf-font-display)",
                fontSize: 64,
                fontWeight: 600,
                lineHeight: 1.05,
                letterSpacing: "-0.32px",
                color: "var(--sf-fg-on-dark-1)",
              }}
            >
              5 mins a day. <br />
              Every post on strategy.
            </h2>
          </div>
          <PostCard post={POST} />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
