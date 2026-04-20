'use client';

/**
 * ShipFlare v2 — Source filter rail.
 *
 * Horizontal chip row. Chips double as:
 *   1. Scan-status indicators (queued / searching / searched / failed),
 *      driven by live BullMQ events from useProgressiveStream('discovery').
 *   2. Filter toggles — clicking a searched chip scopes the reply list
 *      to that source; re-clicking clears.
 *
 * Per INTERACTIONS.md §5. Appearance stagger on scan open is in the parent
 * (via delay-based mount) — each chip applies its own `appearDelay` so we
 * get the 320ms inter-chip stagger described in §4.
 */

import { type CSSProperties, useEffect, useState } from 'react';
import { StatusDot } from '@/components/ui/status-dot';
import type { ItemSnapshot } from '@/hooks/use-progressive-stream';
import type { SourceChipData } from '@/components/today/source-chip';
import type { ScanSource } from '../_hooks/use-scan-flow';

type ChipState = 'queued' | 'searching' | 'searched' | 'failed';

interface SourceFilterRailProps {
  sources: ScanSource[];
  chipState: Map<string, ItemSnapshot<SourceChipData>>;
  /** Currently-selected filter (chip id). Null = no filter. */
  filterId: string | null;
  onFilterChange: (id: string | null) => void;
  onRetrySource: (platform: string, source: string) => void;
  /** Whether a scan is in flight. Drives the staggered appearance. */
  scanning: boolean;
}

export function SourceFilterRail({
  sources,
  chipState,
  filterId,
  onFilterChange,
  onRetrySource,
  scanning,
}: SourceFilterRailProps) {
  if (sources.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Discovery source progress"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        padding: '0 clamp(16px, 3vw, 32px)',
        marginBottom: 20,
      }}
    >
      {sources.map((s, i) => {
        const id = `${s.platform}:${s.source}`;
        const snapshot = chipState.get(id);
        const raw = (snapshot?.state ?? 'queued') as string;
        // Bucket stream-level states that aren't chip states into queued/searching.
        const chipBucket: ChipState =
          raw === 'searched' || raw === 'failed' || raw === 'searching'
            ? (raw as ChipState)
            : 'queued';
        const isFiltered = filterId === id;

        return (
          <SourceChip
            key={id}
            id={id}
            label={s.source}
            state={chipBucket}
            count={snapshot?.data?.aboveGate ?? snapshot?.data?.found ?? 0}
            active={isFiltered}
            onClick={() => {
              if (chipBucket === 'failed') {
                onRetrySource(s.platform, s.source);
                return;
              }
              onFilterChange(isFiltered ? null : id);
            }}
            appearDelay={scanning ? 320 * i : 0}
          />
        );
      })}
    </div>
  );
}

/* ── Chip ────────────────────────────────────────────────────────── */

interface SourceChipProps {
  id: string;
  label: string;
  state: ChipState;
  count: number;
  active: boolean;
  onClick: () => void;
  appearDelay: number;
}

const STATE_STYLES: Record<ChipState, { bg: string; fg: string }> = {
  queued: { bg: 'var(--sf-paper-sunken)', fg: 'var(--sf-fg-4)' },
  searching: { bg: 'var(--sf-paper-sunken)', fg: 'var(--sf-fg-2)' },
  searched: { bg: 'var(--sf-success-tint)', fg: 'var(--sf-success-ink)' },
  failed: { bg: 'var(--sf-danger-tint)', fg: 'var(--sf-danger-ink)' },
};

function SourceChip({
  id,
  label,
  state,
  count,
  active,
  onClick,
  appearDelay,
}: SourceChipProps) {
  // Key-based reset so we don't call setState synchronously in an effect
  // just to flip back to hidden when `appearDelay` changes. We track the
  // delay the state corresponds to; if the prop drifts, we synchronously
  // render hidden and let the effect below schedule a new reveal.
  const [revealedDelay, setRevealedDelay] = useState<number | null>(
    appearDelay === 0 ? 0 : null,
  );

  useEffect(() => {
    // Delay 0 = always shown; no timer needed.
    if (appearDelay === 0) return;
    const t = setTimeout(() => setRevealedDelay(appearDelay), appearDelay);
    return () => clearTimeout(t);
  }, [appearDelay]);

  // `appeared` is the derived truth of whether we've crossed the delay
  // threshold for the *current* appearDelay value. When the prop changes
  // mid-flight, revealedDelay still reflects the stale delay, so we flip
  // back to hidden until the new timer fires.
  const appeared =
    appearDelay === 0 || revealedDelay === appearDelay;

  const s = STATE_STYLES[state];
  const isFailed = state === 'failed';

  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    borderRadius: 'var(--sf-radius-pill)',
    border: '1px solid transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    background: s.bg,
    color: s.fg,
    fontSize: 'var(--sf-text-xs)',
    fontWeight: 500,
    letterSpacing: 'var(--sf-track-normal)',
    boxShadow: active ? '0 0 0 2px var(--sf-signal)' : 'none',
    opacity: appeared ? 1 : 0,
    transform: appeared ? 'translateY(0)' : 'translateY(4px)',
    transition:
      'background var(--sf-dur-base) var(--sf-ease-swift), color var(--sf-dur-base) var(--sf-ease-swift), opacity var(--sf-dur-base), transform var(--sf-dur-base), box-shadow var(--sf-dur-base)',
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={
        isFailed ? `Retry search for ${label}` : `Filter replies by ${label}`
      }
      data-source-id={id}
      data-state={state}
      style={style}
    >
      {state === 'searching' && <StatusDot state="active" size={6} />}
      <span>{label}</span>
      {state === 'searched' && (
        <span className="sf-mono" style={{ marginLeft: 2 }}>
          {count}
        </span>
      )}
      {state === 'failed' && <span style={{ marginLeft: 2 }}>· failed</span>}
    </button>
  );
}
