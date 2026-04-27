'use client';

/**
 * Horizontal filter chip row above the reply list. Clicking a chip
 * scopes the list to one (platform, community); re-clicking clears.
 *
 * Discovery is cron-driven, so chips no longer carry live scan state —
 * they are pure filter affordances derived from whatever is currently
 * surfaced in `/api/today`.
 */

import { type CSSProperties, useEffect, useState } from 'react';

export interface SourceFilterEntry {
  platform: string;
  source: string;
}

interface SourceFilterRailProps {
  sources: SourceFilterEntry[];
  /** Currently-selected filter (chip id). Null = no filter. */
  filterId: string | null;
  onFilterChange: (id: string | null) => void;
  /** Total unfiltered reply count — shown on the leading "All" pill. */
  totalCount: number;
}

const CHIP_STAGGER_INITIAL_MS = 60;

/**
 * Render chips in the platform's natural vocabulary, not the raw
 * community string the discovery agent wrote. Reddit `source` is
 * already `r/foo`; on X we encode the search query as the community
 * (e.g. `"X - social media marketing"`) because X has no real
 * community concept and the schema requires community NOT NULL.
 * Strip the noisy `"X - "` / `"X / "` prefix and prepend `𝕏 ·`.
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
        const id = `${s.platform}:${s.source}`;
        const isFiltered = filterId === id;
        return (
          <SourceChip
            key={id}
            id={id}
            label={formatChipLabel(s.platform, s.source)}
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
  active: boolean;
  onClick: () => void;
  appearDelay: number;
}

function SourceChip({ id, label, active, onClick, appearDelay }: SourceChipProps) {
  const appeared = useRevealed(appearDelay);

  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    borderRadius: 'var(--sf-radius-pill)',
    border: '1px solid transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    background: 'var(--sf-bg-tertiary)',
    color: 'var(--sf-fg-2)',
    fontSize: 'var(--sf-text-xs)',
    fontWeight: 500,
    letterSpacing: 'var(--sf-track-normal)',
    boxShadow: active ? '0 0 0 2px var(--sf-accent)' : 'none',
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
      aria-label={`Filter replies by ${label}`}
      data-source-id={id}
      style={style}
    >
      <span>{label}</span>
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
