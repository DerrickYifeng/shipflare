/**
 * ShipFlare v2 per-route HeaderBar.
 *
 * Reusable header for authenticated app routes. Renders:
 * - `<h2>` title (via `.sf-h2` signature class)
 * - Optional one-line meta (subtitle) beneath
 * - Optional action slot on the right (typically a <Button />)
 * - Optional health score ring (backcompat with Today page)
 *
 * Pixel reference: handoff shell.jsx `HeaderBar` + today.jsx header block.
 */

import type { ReactNode } from 'react';
import { HealthScoreRing } from '@/components/dashboard/health-score-ring';

export interface HeaderBarProps {
  title: string;
  /** Optional subtitle beneath the title — e.g. "3 to review · last scan 14m ago". */
  meta?: ReactNode;
  /** Optional right-side action node. Typically a <Button /> or cluster. */
  action?: ReactNode;
  /** Backcompat: render the health score ring on the right. Ignored if `action` is provided. */
  healthScore?: number | null;
}

export function HeaderBar({ title, meta, action, healthScore }: HeaderBarProps) {
  const right = action ?? (healthScore != null ? <HealthScoreRingWithLabel score={healthScore} /> : null);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
        padding: '28px clamp(16px, 3vw, 32px) 16px',
      }}
    >
      <div style={{ minWidth: 0, flex: '1 1 300px' }}>
        <h1
          className="sf-h2"
          style={{ margin: 0, color: 'var(--sf-fg-1)' }}
        >
          {title}
        </h1>
        {meta ? (
          <p
            style={{
              margin: '6px 0 0',
              fontSize: 'var(--sf-text-sm)',
              color: 'var(--sf-fg-3)',
              letterSpacing: 'var(--sf-track-normal)',
            }}
          >
            {meta}
          </p>
        ) : null}
      </div>
      {right ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          {right}
        </div>
      ) : null}
    </div>
  );
}

function HealthScoreRingWithLabel({ score }: { score: number }) {
  return (
    <>
      <HealthScoreRing score={score} size={36} />
      <span
        className="sf-mono"
        style={{
          fontSize: 'var(--sf-text-sm)',
          color: 'var(--sf-fg-3)',
          letterSpacing: 'var(--sf-track-mono)',
        }}
      >
        {score}
      </span>
    </>
  );
}
