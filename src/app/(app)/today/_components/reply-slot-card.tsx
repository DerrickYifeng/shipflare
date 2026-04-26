'use client';

/**
 * ReplySlotCard — progress indicator for one of today's content_reply
 * plan_item slots. Single line per channel: "Today's reply session: Y
 * of N drafted" with a state-colored dot. Sits at the top of the
 * Replies section so the founder sees the daily reply target before
 * scrolling through individual drafts.
 *
 * Three visible states:
 *   - planned  — daily cron hasn't filled the slot yet. Show the
 *                target + scheduled time. Drafted count usually 0,
 *                but if drafts already landed (manual scout, prior
 *                attempts) we still surface them.
 *   - drafted  — coordinator finished the retry loop. The drafted
 *                count is final; the actual reply cards below show
 *                the bodies.
 *   - completed — all the drafts have been approved/skipped. Card
 *                still rendered for the day so the founder can see
 *                "you handled all 5 today" at a glance.
 */

import type { CSSProperties } from 'react';
import { PLATFORMS } from '@/lib/platform-config';
import type { ReplySlot } from '@/hooks/use-today';

interface ReplySlotCardProps {
  slot: ReplySlot;
}

function platformDisplay(channel: string): string {
  return PLATFORMS[channel]?.displayName ?? channel.toUpperCase();
}

function formatScheduledHour(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function progressLabel(slot: ReplySlot): string {
  const { state, draftedToday, targetCount } = slot;
  if (state === 'planned' && draftedToday === 0) {
    return `${targetCount} planned`;
  }
  return `${draftedToday} of ${targetCount} drafted`;
}

function dotColor(slot: ReplySlot): string {
  if (slot.draftedToday >= slot.targetCount) return 'var(--sf-success)';
  if (slot.state === 'drafted') return 'var(--sf-warning)';
  return 'var(--sf-fg-4)';
}

export function ReplySlotCard({ slot }: ReplySlotCardProps) {
  const articleStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 18px',
    borderRadius: 'var(--sf-radius-md)',
    background: 'var(--sf-bg-secondary)',
    boxShadow: 'var(--sf-shadow-card)',
    fontSize: 'var(--sf-text-sm)',
    color: 'var(--sf-fg-2)',
    letterSpacing: 'var(--sf-track-normal)',
  };

  const dotStyle: CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: dotColor(slot),
    flexShrink: 0,
  };

  const scheduled = formatScheduledHour(slot.scheduledAt);

  return (
    <article style={articleStyle} aria-label="Today's reply session">
      <span style={dotStyle} aria-hidden />
      <span style={{ fontWeight: 500, color: 'var(--sf-fg-1)' }}>
        Today's {platformDisplay(slot.channel)} reply session
      </span>
      <span style={{ color: 'var(--sf-fg-3)' }}>·</span>
      <span
        className="sf-mono"
        style={{
          letterSpacing: 'var(--sf-track-mono)',
          color: 'var(--sf-fg-1)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {progressLabel(slot)}
      </span>
      {scheduled ? (
        <>
          <span style={{ color: 'var(--sf-fg-3)' }}>·</span>
          <span
            className="sf-mono"
            style={{
              letterSpacing: 'var(--sf-track-mono)',
              color: 'var(--sf-fg-3)',
            }}
          >
            {scheduled}
          </span>
        </>
      ) : null}
    </article>
  );
}
