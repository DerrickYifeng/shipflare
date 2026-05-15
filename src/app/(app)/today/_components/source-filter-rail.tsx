'use client';

/**
 * Horizontal filter chip row above the reply list. One chip per
 * platform (X, Reddit); clicking scopes the list to that platform,
 * re-clicking clears.
 *
 * Discovery is cron-driven, so chips no longer carry live scan state —
 * they are pure filter affordances derived from whatever is currently
 * surfaced in `/api/today`.
 */

import { type CSSProperties, useEffect, useState } from 'react';

export interface SourceFilterEntry {
  platform: string;
  /** Reply count for this platform — surfaces as the chip's count badge. */
  count: number;
}

interface SourceFilterRailProps {
  sources: SourceFilterEntry[];
  /** Currently-selected platform filter. Null = no filter. */
  filterId: string | null;
  onFilterChange: (id: string | null) => void;
  /** Total unfiltered reply count — shown on the leading "All" pill. */
  totalCount: number;
}

const CHIP_STAGGER_INITIAL_MS = 60;

function platformLabel(platform: string): string {
  if (platform === 'x') return '𝕏';
  if (platform === 'reddit') return 'Reddit';
  return platform;
}

export function SourceFilterRail({
  sources,
  filterId,
  onFilterChange,
  totalCount,
}: SourceFilterRailProps) {
  if (sources.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Source filter"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        padding: '0 clamp(16px, 3vw, 32px)',
        marginBottom: 20,
      }}
    >
      <AllFilterPill
        count={totalCount}
        active={filterId === null}
        onClick={() => onFilterChange(null)}
        appearDelay={0}
      />
      {sources.map((s, i) => {
        const id = s.platform;
        const isFiltered = filterId === id;
        return (
          <SourceChip
            key={id}
            id={id}
            label={platformLabel(s.platform)}
            count={s.count}
            active={isFiltered}
            onClick={() => onFilterChange(isFiltered ? null : id)}
            appearDelay={CHIP_STAGGER_INITIAL_MS * (i + 1)}
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
  const appeared = useRevealed(appearDelay);

  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    borderRadius: 'var(--sf-radius-pill)',
    border: active ? '1px solid var(--sf-bg-dark)' : '1px solid var(--sf-border)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    background: active ? 'var(--sf-bg-dark)' : 'transparent',
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
  count: number;
  active: boolean;
  onClick: () => void;
  appearDelay: number;
}

function SourceChip({ id, label, count, active, onClick, appearDelay }: SourceChipProps) {
  const appeared = useRevealed(appearDelay);

  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    borderRadius: 'var(--sf-radius-pill)',
    border: active ? '1px solid var(--sf-bg-dark)' : '1px solid transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    background: active ? 'var(--sf-bg-dark)' : 'var(--sf-bg-tertiary)',
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
      aria-label={`Filter replies by ${label}`}
      data-source-id={id}
      style={style}
    >
      <span>{label}</span>
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

/* ── Reveal helper ───────────────────────────────────────────────── */

function useRevealed(appearDelay: number): boolean {
  const [revealed, setRevealed] = useState(appearDelay === 0);
  useEffect(() => {
    if (appearDelay === 0) {
      queueMicrotask(() => setRevealed(true));
      return;
    }
    queueMicrotask(() => setRevealed(false));
    const t = setTimeout(() => setRevealed(true), appearDelay);
    return () => clearTimeout(t);
  }, [appearDelay]);
  return revealed;
}
