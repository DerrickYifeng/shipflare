import type { CSSProperties } from 'react';
import { colorHexForAgentType, roleCodeForAgentType } from './agent-accent';

export interface BudgetSegment {
  memberId: string;
  agentType: string;
  displayName: string;
  /** Dollars this week attributed to this member. Clamped to ≥ 0. */
  spentUsd: number;
}

export interface TokenBudgetProps {
  spentUsd: number;
  weeklyBudgetUsd: number;
  segments: readonly BudgetSegment[];
}

function formatDollars(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  return `$${n.toFixed(2)}`;
}

export function TokenBudget({
  spentUsd,
  weeklyBudgetUsd,
  segments,
}: TokenBudgetProps) {
  const safeSpent = Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0;
  const safeBudget =
    Number.isFinite(weeklyBudgetUsd) && weeklyBudgetUsd > 0
      ? weeklyBudgetUsd
      : 0;

  const denominator = Math.max(safeBudget, safeSpent, 0.0001);
  const barSegments = segments
    .map((seg) => ({
      ...seg,
      spentUsd: Math.max(0, seg.spentUsd),
    }))
    .filter((seg) => seg.spentUsd > 0);

  const wrap: CSSProperties = {
    marginTop: 10,
    padding: '12px 12px 10px',
    background: 'var(--sf-bg-secondary)',
    borderRadius: 10,
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.03)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  };

  const headerRow: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  };

  const label: CSSProperties = {
    fontSize: 10,
    fontFamily: 'var(--sf-font-mono)',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: 'var(--sf-fg-1)',
  };

  const totalRow: CSSProperties = {
    fontSize: 11,
    fontFamily: 'var(--sf-font-mono)',
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--sf-fg-1)',
  };

  const totalDenominator: CSSProperties = {
    color: 'var(--sf-fg-4)',
  };

  const bar: CSSProperties = {
    display: 'flex',
    height: 5,
    background: 'var(--sf-bg-tertiary)',
    borderRadius: 999,
    overflow: 'hidden',
  };

  const legend: CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    rowGap: 4,
    columnGap: 10,
    marginTop: 2,
  };

  const legendItem: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10,
    fontFamily: 'var(--sf-font-mono)',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: 'rgba(0, 0, 0, 0.56)',
  };

  return (
    <section style={wrap} aria-label="Weekly budget">
      <div style={headerRow}>
        <span style={label}>Weekly Budget</span>
        <span style={totalRow}>
          {formatDollars(safeSpent)}
          <span style={totalDenominator}>{` / ${formatDollars(safeBudget)}`}</span>
        </span>
      </div>

      <div style={bar} role="img" aria-label={`${formatDollars(safeSpent)} spent of ${formatDollars(safeBudget)} weekly budget`}>
        {barSegments.map((seg) => {
          const pct = Math.min(100, (seg.spentUsd / denominator) * 100);
          const segStyle: CSSProperties = {
            width: `${pct}%`,
            background: colorHexForAgentType(seg.agentType),
          };
          return <div key={seg.memberId} style={segStyle} />;
        })}
      </div>

      <div style={legend}>
        {segments.map((seg) => {
          const swatch: CSSProperties = {
            width: 6,
            height: 6,
            borderRadius: 2,
            background: colorHexForAgentType(seg.agentType),
            flexShrink: 0,
          };
          const role = roleCodeForAgentType(seg.agentType);
          return (
            <span key={seg.memberId} style={legendItem}>
              <span style={swatch} aria-hidden="true" />
              {role}
            </span>
          );
        })}
      </div>
    </section>
  );
}
