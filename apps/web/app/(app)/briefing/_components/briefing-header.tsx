/**
 * BriefingHeader — page hero showing today's approval status.
 *
 * Ported from Railway's BriefingHeader. Simplified to accept flat
 * counts rather than a server-fetched BriefingSummary object; the
 * CF Briefing page derives these counts via useCmoStub.queryDrafts.
 */

import type { CSSProperties } from "react";

export interface BriefingCounts {
  /** Number of drafts awaiting founder review. */
  awaiting: number;
  /** Number of plan items scheduled for today. */
  todayItems: number;
}

export interface BriefingHeaderProps {
  /** `null` while loading. */
  counts: BriefingCounts | null;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "20px clamp(16px, 3vw, 32px) 12px",
};

const titleStyle: CSSProperties = {
  margin: 0,
  color: "var(--sf-fg-1)",
};

const subtitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--sf-fg-2)",
  fontSize: 14,
};

export function BriefingHeader({ counts }: BriefingHeaderProps) {
  if (!counts) {
    return (
      <header style={containerStyle}>
        <h1 className="sf-h2" style={titleStyle}>
          Today
        </h1>
      </header>
    );
  }

  const { awaiting, todayItems } = counts;
  const allClear = awaiting === 0 && todayItems === 0;

  if (allClear) {
    return (
      <header style={containerStyle}>
        <h1 className="sf-h2" style={titleStyle}>
          All clear
        </h1>
        <p style={subtitleStyle}>Nothing awaiting your review.</p>
      </header>
    );
  }

  return (
    <header style={containerStyle}>
      <h1 className="sf-h2" style={titleStyle}>
        Today · {awaiting} awaiting
      </h1>
      <p style={subtitleStyle}>{todayItems} plan items today</p>
    </header>
  );
}
