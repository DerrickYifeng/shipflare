'use client';

import { useBriefingHistory } from '@/hooks/use-briefing-history';
import { ReplyCard } from '@/app/(app)/today/_components/reply-card';

/**
 * Briefing → History tab. Shows reply drafts the founder has already
 * acted on (handed off to X compose, or posted via Reddit) within the
 * trailing window. Each card uses <ReplyCard /> in its settled-state
 * mode: a single "Open X again" / "View on Reddit" button, no
 * Edit/Skip cluster.
 *
 * v1 surfaces replies only — completed scheduled posts (plan_items.state
 * = 'completed') are a follow-up.
 */
export function HistoryTab() {
  const { items, windowDays, isLoading, error } = useBriefingHistory();

  return (
    <div
      style={{
        paddingTop: 28,
        padding: '28px clamp(16px, 3vw, 32px)',
        maxWidth: 920,
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          marginBottom: 16,
          fontSize: 'var(--sf-text-xs)',
          color: 'var(--sf-fg-3)',
          letterSpacing: 'var(--sf-track-mono)',
          fontFamily: 'var(--sf-font-mono)',
        }}
      >
        Replied or posted in the last {windowDays} days · newest first
      </div>

      {error ? (
        <p
          style={{
            color: 'var(--sf-error)',
            fontSize: 'var(--sf-text-sm)',
          }}
        >
          Couldn&apos;t load history. Try refreshing.
        </p>
      ) : isLoading && items.length === 0 ? (
        <p
          className="sf-mono"
          style={{
            fontSize: 'var(--sf-text-xs)',
            color: 'var(--sf-fg-3)',
          }}
        >
          Loading…
        </p>
      ) : items.length === 0 ? (
        <p
          style={{
            fontSize: 'var(--sf-text-sm)',
            color: 'var(--sf-fg-3)',
          }}
        >
          Nothing here yet. Replies you send will show up here so you can
          re-open them later.
        </p>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {items.map((item) => (
            <ReplyCard
              key={item.id}
              item={item}
              // History view is read-only — these handlers are required
              // by the prop type but the settled-status branch never
              // calls Send / Edit / Skip. Stub them out.
              onApprove={noop}
              onSkip={noop}
              onEdit={noopEdit}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function noop(): void {
  /* settled cards never call these */
}

function noopEdit(): void {
  /* settled cards never call these */
}
