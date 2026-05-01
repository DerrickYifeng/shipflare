import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { BRAND_EASE } from "../lib/easing";
import { ReplyCard } from "../components/ReplyCard";
import { PostCard } from "../components/PostCard";
import { AgentBadge } from "../components/AgentBadge";
import { POST, REPLY } from "../lib/data";

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
    <AbsoluteFill style={{ background: "var(--sf-bg-dark)" }}>
      {/* Reply phase */}
      {replyOp > 0 ? (
        <div style={{ position: "absolute", inset: 0, opacity: replyOp }}>
          <TitleBlock
            badgeRole="Social Agent"
            badgeCaption="real prospects"
            headline="Reply to real potential customers."
          />
          <CardWrap>
            <ReplyCard reply={REPLY} />
          </CardWrap>
        </div>
      ) : null}

      {/* Post phase */}
      {postOp > 0 ? (
        <div style={{ position: "absolute", inset: 0, opacity: postOp }}>
          <TitleBlock
            badgeRole="Content Agent"
            badgeCaption="phase-aligned"
            headline="5 mins a day. Every post on strategy."
          />
          <CardWrap>
            <PostCard post={POST} />
          </CardWrap>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

interface TitleBlockProps {
  badgeRole: string;
  badgeCaption: string;
  headline: string;
}

const TitleBlock: React.FC<TitleBlockProps> = ({
  badgeRole,
  badgeCaption,
  headline,
}) => (
  <div
    style={{
      position: "absolute",
      top: 120,
      left: 80,
      right: 80,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 16,
      textAlign: "center",
    }}
  >
    <AgentBadge role={badgeRole} caption={badgeCaption} />
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
      {headline}
    </h2>
  </div>
);

const CardWrap: React.FC<{ children: React.ReactNode }> = ({ children }) => (
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
    <div style={{ width: 1100 }}>{children}</div>
  </div>
);
