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
  /** Total unfiltered reply count — shown on the leading "All" pill. */
  totalCount: number;
}

/**
 * Stagger timings sourced verbatim from INTERACTIONS.md §4 step 4
 * ("t = 400 + i*320ms") and the prototype's `pages.jsx:269` inverse
 * (`scanning ? 0 : i * 60`).
 *
 *   CHIP_STAGGER_INITIAL_MS  60   — instant mount cascade when idle
 *   CHIP_STAGGER_SCAN_HEAD_MS 400 — hold every chip for 400ms before the
 *                                   320ms-per-chip scan cascade fires
 *   CHIP_STAGGER_SCAN_STEP_MS 320 — inter-chip step during an active scan
 */
const CHIP_STAGGER_INITIAL_MS = 60;
const CHIP_STAGGER_SCAN_HEAD_MS = 400;
const CHIP_STAGGER_SCAN_STEP_MS = 320;

/**
 * Render chips in the platform's natural vocabulary, not the raw
 * community string the discovery agent wrote.
 *
 * On Reddit, `source` is already `r/foo` — pass through.
 * On X, the discovery agent encodes the search query as the community
 * (e.g. `"X - social media marketing"`) because X has no real community
 * concept and the schema requires community NOT NULL. Strip the noisy
 * `"X - "` / `"X / "` prefix and prepend the `𝕏 ·` mark so chips read as
 * `𝕏 · social media marketing` instead of `X - social media marketing`.
 */
function formatChipLabel(platform: string, source: string): string {
  if (platform === 'x') {
    const cleaned = source.replace(/^X\s*[-/]\s*/i, '').trim();
    return `𝕏 · ${cleaned || 'mentions'}`;
  }
  return source;
}

export function SourceFilterRail({
  sources,
  chipState,
  filterId,
  onFilterChange,
  onRetrySource,
  scanning,
  totalCount,
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
      {/* Leading "All" pill — clears the active filter when clicked. Per
          prototype source/app/pages.jsx:269, this is always the first chip
          and visually distinct: ink fill when active, bordered pill otherwise. */}
      <AllFilterPill
        count={totalCount}
        active={filterId === null}
        onClick={() => onFilterChange(null)}
        appearDelay={
          scanning ? CHIP_STAGGER_SCAN_HEAD_MS : 0
        }
      />
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
            label={formatChipLabel(s.platform, s.source)}
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
            // During a scan: 400ms head start, then 320ms per chip.
            // Idle mount: 60ms per chip in source order. The "All" pill
            // consumes index 0 of the scan cascade so the first source
            // chip lands at 400 + 320ms.
            appearDelay={
              scanning
                ? CHIP_STAGGER_SCAN_HEAD_MS +
                  CHIP_STAGGER_SCAN_STEP_MS * (i + 1)
                : CHIP_STAGGER_INITIAL_MS * (i + 1)
            }
          />
        );
      })}
    </div>
  );
}

/* ── All pill ────────────────────────────────────────────────────── */

interface AllFilterPillProps {
  count: number;
  active: boolean;
  onClick: () => void;
  appearDelay: number;
}

function AllFilterPill({ count, active, onClick, appearDelay }: AllFilterPillProps) {
  const [revealedDelay, setRevealedDelay] = useState<number | null>(
    appearDelay === 0 ? 0 : null,
  );

  useEffect(() => {
    if (appearDelay === 0) return;
    const t = setTimeout(() => setRevealedDelay(appearDelay), appearDelay);
    return () => clearTimeout(t);
  }, [appearDelay]);

  const appeared =
    appearDelay === 0 || revealedDelay === appearDelay;

  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    borderRadius: 'var(--sf-radius-pill)',
    border: active ? '1px solid var(--sf-ink)' : '1px solid var(--sf-border)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    background: active ? 'var(--sf-ink)' : 'transparent',
    color: active ? 'var(--sf-fg-on-dark-1)' : 'var(--sf-fg-2)',
    fontSize: 'var(--sf-text-xs)',
    fontWeight: 500,
    letterSpacing: 'var(--sf-track-normal)',
    opacity: appeared ? 1 : 0,
    transform: appeared ? 'translateY(0)' : 'translateY(4px)',
    transition:
      'background var(--sf-dur-base) var(--sf-ease-swift), color var(--sf-dur-base) var(--sf-ease-swift), border-color var(--sf-dur-base) var(--sf-ease-swift), opacity var(--sf-dur-base), transform var(--sf-dur-base)',
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={active ? 'All sources selected' : 'Show all sources'}
      data-filter-id="__all__"
      style={style}
    >
      <span>All</span>
      <span
        className="sf-mono"
        style={{
          marginLeft: 2,
          letterSpacing: 'var(--sf-track-mono)',
          color: active ? 'var(--sf-fg-on-dark-3)' : 'var(--sf-fg-4)',
        }}
      >
        {count}
      </span>
    </button>
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
