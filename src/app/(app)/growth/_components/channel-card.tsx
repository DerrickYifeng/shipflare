'use client';

import type { ReactNode } from 'react';
import { Ops } from '@/components/ui/ops';

export interface ChannelOverview {
  platform: string;
  displayName: string;
  connected: boolean;
  handleOrLabel: string;
  score: number | null;
  threads: number;
  drafts: number;
  posts: number;
  replies: number;
  pending: number;
  approveRate: number | null;
  lastPostAt: string | null;
}

interface ChannelCardProps {
  channel: ChannelOverview;
  /** Slot rendered below the meta line — currently used by Reddit subreddit chips. */
  footerSlot?: ReactNode;
}

function PlatformTile({ platform }: { platform: string }) {
  const styles: Record<string, { bg: string; glyph: string }> = {
    x: { bg: '#000', glyph: '𝕏' },
    reddit: { bg: '#ff4500', glyph: 'R' },
  };
  const s = styles[platform] ?? { bg: 'var(--sf-fg-3)', glyph: '?' };
  return (
    <span
      aria-hidden="true"
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        background: s.bg,
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 600,
      }}
    >
      {s.glyph}
    </span>
  );
}

function formatLastPost(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const ago = Math.max(0, Date.now() - then);
  const h = Math.floor(ago / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatApproveRate(rate: number | null): string {
  if (rate == null) return '—';
  return `${Math.round(rate * 100)}%`;
}

export function ChannelCard({ channel, footerSlot }: ChannelCardProps) {
  const disconnected = !channel.connected;
  return (
    <div
      data-testid={`channel-card-${channel.platform}`}
      style={{
        background: 'var(--sf-bg-primary)',
        borderRadius: 12,
        padding: 18,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <PlatformTile platform={channel.platform} />
          <div>
            <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--sf-fg-1)' }}>
              {channel.displayName}
            </div>
            <Ops style={{ marginTop: 2 }}>{channel.handleOrLabel}</Ops>
          </div>
        </div>
        <Ops style={{ color: disconnected ? 'var(--sf-fg-3)' : 'var(--sf-success-ink)' }}>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: disconnected ? 'transparent' : 'var(--sf-success)',
              border: disconnected ? '1px solid var(--sf-fg-3)' : 'none',
              marginRight: 6,
              verticalAlign: 'middle',
            }}
          />
          {disconnected ? 'Not connected' : 'Active'}
        </Ops>
      </div>

      {disconnected ? (
        <p
          style={{
            margin: 0,
            fontSize: 'var(--sf-text-sm)',
            color: 'var(--sf-fg-3)',
            lineHeight: 'var(--sf-lh-normal)',
          }}
        >
          Connect this channel from onboarding to start shipping content here.
        </p>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 12,
              marginBottom: 12,
            }}
          >
            <Metric label="Threads" value={channel.threads} />
            <Metric label="Drafts" value={channel.drafts} />
            <Metric label="Posts" value={channel.posts} />
            <Metric label="Replies" value={channel.replies} />
          </div>

          <div
            className="sf-mono"
            style={{
              fontSize: 'var(--sf-text-xs)',
              color: 'var(--sf-fg-3)',
              letterSpacing: '-0.12px',
              paddingTop: 8,
              borderTop: '1px solid rgba(0,0,0,0.06)',
            }}
          >
            Pending {channel.pending} · Approve rate {formatApproveRate(channel.approveRate)} · Last post {formatLastPost(channel.lastPostAt)}
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
        className="sf-mono"
        style={{
          fontSize: 32,
          fontWeight: 600,
          letterSpacing: '-0.6px',
          color: 'var(--sf-fg-1)',
          marginTop: 4,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
    </div>
  );
}
