"use client";

import type { ReactNode } from "react";
import { Ops } from "@/components/ui/ops";
import type { ChannelCard as ChannelOverview } from "../growth-content";

interface ChannelCardProps {
  channel: ChannelOverview;
  /** Slot rendered below metrics — currently used by Reddit subreddit chips. */
  footerSlot?: ReactNode;
}

const METRIC_LABELS: Record<string, string> = {
  // X metrics
  impressions: "Impressions",
  likes: "Likes",
  replies: "Replies",
  reposts: "Reposts",
  followers: "Followers",
  posts_7d: "Posts (7d)",
  // Reddit metrics
  post_count: "Posts",
  comment_count: "Comments",
  karma_7d: "Karma (7d)",
};

const PLATFORM_DISPLAY: Record<string, { label: string; bg: string; glyph: string }> = {
  x: { label: "X (Twitter)", bg: "#000", glyph: "𝕏" },
  reddit: { label: "Reddit", bg: "#ff4500", glyph: "R" },
};

function PlatformTile({ platform }: { platform: string }) {
  const s = PLATFORM_DISPLAY[platform] ?? { bg: "var(--sf-fg-3)", glyph: "?" };
  return (
    <span
      aria-hidden="true"
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        background: s.bg,
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
      }}
    >
      {s.glyph}
    </span>
  );
}

function formatCapturedAt(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const ago = Math.max(0, Date.now() - then);
  const h = Math.floor(ago / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function ChannelCard({ channel, footerSlot }: ChannelCardProps) {
  const { platform, live, username, metrics, capturedAt } = channel;
  const meta = PLATFORM_DISPLAY[platform] ?? { label: platform, bg: "var(--sf-fg-3)", glyph: "?" };
  const handleOrLabel = username ? `@${username}` : meta.label;

  // Extract known metric keys; fall back to zeros so numbers always render.
  const metricEntries = Object.entries(metrics);

  return (
    <div
      data-testid={`channel-card-${platform}`}
      style={{
        background: "var(--sf-bg-primary)",
        borderRadius: 12,
        padding: 18,
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <PlatformTile platform={platform} />
          <div>
            <div style={{ fontSize: 17, fontWeight: 600, color: "var(--sf-fg-1)" }}>
              {meta.label}
            </div>
            <Ops style={{ marginTop: 2 }}>{handleOrLabel}</Ops>
          </div>
        </div>
        <Ops style={{ color: live ? "var(--sf-success-ink)" : "var(--sf-fg-3)" }}>
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: live ? "var(--sf-success)" : "transparent",
              border: live ? "none" : "1px solid var(--sf-fg-3)",
              marginRight: 6,
              verticalAlign: "middle",
            }}
          />
          {live ? "Active" : "Not connected"}
        </Ops>
      </div>

      {/* Body */}
      {!live ? (
        <p
          style={{
            margin: 0,
            fontSize: 14,
            color: "var(--sf-fg-3)",
            lineHeight: 1.5,
          }}
        >
          Connect this channel from onboarding to start shipping content here.
        </p>
      ) : (
        <>
          {metricEntries.length > 0 ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${Math.min(metricEntries.length, 4)}, 1fr)`,
                gap: 12,
                marginBottom: 12,
              }}
            >
              {metricEntries.map(([key, val]) => (
                <Metric key={key} label={METRIC_LABELS[key] ?? key} value={val} />
              ))}
            </div>
          ) : (
            <p
              style={{
                margin: "0 0 12px",
                fontSize: 14,
                color: "var(--sf-fg-3)",
              }}
            >
              No metrics yet — data updates each day.
            </p>
          )}

          <div
            style={{
              fontSize: 12,
              color: "var(--sf-fg-3)",
              letterSpacing: "-0.12px",
              paddingTop: 8,
              borderTop: "1px solid rgba(0,0,0,0.06)",
            }}
          >
            Last snapshot {formatCapturedAt(capturedAt)}
          </div>

          {footerSlot}
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <Ops>{label}</Ops>
      <div
        style={{
          fontSize: 32,
          fontWeight: 600,
          letterSpacing: "-0.6px",
          color: "var(--sf-fg-1)",
          marginTop: 4,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}
