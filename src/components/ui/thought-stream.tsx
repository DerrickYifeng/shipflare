import type { CSSProperties, ReactNode } from 'react';

import { Ops } from './ops';
import { StatusDot } from './status-dot';

export interface ThoughtStep {
  label: ReactNode;
  detail?: ReactNode;
}

export interface ThoughtStreamProps {
  steps: ThoughtStep[];
  /** Index of the currently-active step. Steps after this are dimmed to 0.3 opacity. */
  activeIdx: number;
  /** When true, flips foreground colors for dark surfaces. */
  onDark?: boolean;
  /** Optional header label override. Defaults to `Thinking…`. */
  header?: ReactNode;
  className?: string;
}

const LIST_STYLE: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

/**
 * Signature progress list — Gathering → Searching → Scoring → Drafting.
 * Rendered inside ScanDrawer and anywhere a live agent narrates its thinking.
 */
export function ThoughtStream({
  steps,
  activeIdx,
  onDark = false,
  header,
  className = '',
}: ThoughtStreamProps) {
  const labelColor = onDark ? 'var(--sf-fg-on-dark-1)' : 'var(--sf-fg-1)';
  const detailColor = onDark ? 'var(--sf-fg-on-dark-3)' : 'var(--sf-fg-3)';
  return (
    <div className={className}>
      <Ops tone={onDark ? 'onDark' : 'dim'} style={{ marginBottom: 16, display: 'block' }}>
        {header ?? 'Thinking…'}
      </Ops>
      <ol style={LIST_STYLE}>
        {steps.map((step, i) => {
          const state = i < activeIdx ? 'success' : i === activeIdx ? 'active' : 'idle';
          const itemStyle: CSSProperties = {
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            opacity: i > activeIdx ? 0.3 : 1,
            transition: 'opacity var(--sf-dur-slow) var(--sf-ease-swift)',
          };
          return (
            <li key={i} style={itemStyle}>
              <span style={{ marginTop: 6 }}>
                <StatusDot state={state} />
              </span>
              <div>
                <div
                  style={{
                    fontSize: 'var(--sf-text-base)',
                    fontWeight: 500,
                    color: labelColor,
                  }}
                >
                  {step.label}
                </div>
                {step.detail ? (
                  <div
                    style={{
                      fontSize: 'var(--sf-text-sm)',
                      color: detailColor,
                      marginTop: 2,
                    }}
                  >
                    {step.detail}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
