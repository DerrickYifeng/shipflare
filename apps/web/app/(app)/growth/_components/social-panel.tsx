import { Card } from "@/components/ui/card";
import { Ops } from "@/components/ui/ops";
import { ChannelCard } from "./channel-card";
import { SubredditChips } from "./subreddit-chips";
import type { ChannelCard as ChannelOverview } from "../growth-content";

interface SocialPanelProps {
  moduleScore: number | null;
  managerTitle: string;
  channels: ChannelOverview[];
}

export function SocialPanel({
  moduleScore,
  managerTitle,
  channels,
}: SocialPanelProps) {
  return (
    <Card padding={24}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 18,
        }}
      >
        <div>
          <Ops>Social marketing · last 7 days</Ops>
          <h2
            className="sf-h3"
            style={{ margin: "6px 0 0", color: "var(--sf-fg-1)" }}
          >
            {managerTitle} ·{" "}
            <span style={{ color: "var(--sf-fg-3)", fontWeight: 500 }}>
              {moduleScore == null ? "—" : `${moduleScore}/100`}
            </span>
          </h2>
        </div>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            background: "var(--sf-success-light)",
            color: "var(--sf-success-ink)",
            borderRadius: 999,
            fontFamily: "SF Mono, ui-monospace, monospace",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.4,
            textTransform: "uppercase",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--sf-success-ink)",
            }}
          />
          Active
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: channels.length > 1 ? "1fr 1fr" : "1fr",
          gap: 14,
        }}
      >
        {channels.map((c) => (
          <ChannelCard
            key={c.platform}
            channel={c}
            footerSlot={
              c.platform === "reddit" && c.live ? (
                <SubredditChips subreddits={[]} />
              ) : null
            }
          />
        ))}
      </div>
    </Card>
  );
}
