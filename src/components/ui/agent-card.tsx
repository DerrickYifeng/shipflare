'use client';

import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';

import { Card } from './card';
import { Ops, type OpsTone } from './ops';
import { StatusDot, type StatusDotState } from './status-dot';

export type AgentStatus = 'complete' | 'active' | 'idle' | 'failed';

export interface AgentStat {
  value: ReactNode;
  label: ReactNode;
}

export interface AgentCardProps {
  name: string;
  status: AgentStatus;
  detail: ReactNode;
  stats?: AgentStat[];
  /** Cost in USD (sans $ prefix). Shown in the footer alongside `elapsed`. */
  cost?: number | string;
  /** Elapsed seconds. Shown in the footer alongside `cost`. */
  elapsed?: number | string;
  /** 0–1 progress ratio. Renders a progress bar when status === 'active'. */
  progress?: number;
  className?: string;
}

type StatusMeta = {
  dot: StatusDotState;
  ops: string;
  tone: OpsTone;
};

const STATUS_META: Record<AgentStatus, StatusMeta> = {
  complete: { dot: 'success', ops: 'DONE', tone: 'success' },
  active: { dot: 'active', ops: 'RUNNING', tone: 'signal' },
  idle: { dot: 'idle', ops: 'IDLE', tone: 'dim' },
  failed: { dot: 'danger', ops: 'FAILED', tone: 'danger' },
};

const NAME_STYLE: CSSProperties = {
  fontFamily: 'var(--sf-font-mono)',
  fontSize: 'var(--sf-text-xs)',
  fontWeight: 600,
  letterSpacing: 'var(--sf-track-mono)',
  textTransform: 'uppercase',
  color: 'var(--sf-fg-1)',
};

const DETAIL_STYLE: CSSProperties = {
  margin: '0 0 14px',
  fontSize: 'var(--sf-text-sm)',
  color: 'var(--sf-fg-2)',
  lineHeight: 'var(--sf-lh-normal)',
};

const STAT_VALUE_STYLE: CSSProperties = {
  fontSize: 'var(--sf-text-h3)',
  fontWeight: 500,
  color: 'var(--sf-fg-1)',
  lineHeight: 1,
};

const PROGRESS_TRACK_STYLE: CSSProperties = {
  height: 3,
  background: 'var(--sf-paper-sunken)',
  borderRadius: 2,
  overflow: 'hidden',
  marginBottom: 10,
};

const FOOTER_STYLE: CSSProperties = {
  display: 'flex',
  gap: 10,
  fontFamily: 'var(--sf-font-mono)',
  fontSize: 'var(--sf-text-xs)',
  color: 'var(--sf-fg-3)',
  letterSpacing: 'var(--sf-track-mono)',
};

/**
 * Signature agent status card — used in AI Team and scan drawers.
 * Progress bar animates from 0 → `progress` on mount for a cinematic reveal.
 */
export function AgentCard({
  name,
  status,
  detail,
  stats = [],
  cost,
  elapsed,
  progress = 0,
  className = '',
}: AgentCardProps) {
  const meta = STATUS_META[status];
  // Animate from 0 → progress on mount; later changes to `progress` still transition.
  const [renderedProgress, setRenderedProgress] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setRenderedProgress(progress));
    return () => cancelAnimationFrame(id);
  }, [progress]);

  const showFooter = cost !== undefined || elapsed !== undefined;

  return (
    <Card padding={16} className={className}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <StatusDot state={meta.dot} />
        <span style={NAME_STYLE}>{name}</span>
        <Ops tone={meta.tone} style={{ marginLeft: 'auto' }}>
          {meta.ops}
        </Ops>
      </div>
      <p style={DETAIL_STYLE}>{detail}</p>
      {stats.length > 0 ? (
        <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
          {stats.map((stat, i) => (
            <div key={i}>
              <div className="sf-mono" style={STAT_VALUE_STYLE}>
                {stat.value}
              </div>
              <Ops style={{ marginTop: 4, display: 'block' }}>{stat.label}</Ops>
            </div>
          ))}
        </div>
      ) : null}
      {status === 'active' ? (
        <div style={PROGRESS_TRACK_STYLE}>
          <div
            style={{
              width: `${Math.max(0, Math.min(1, renderedProgress)) * 100}%`,
              height: '100%',
              background: 'var(--sf-signal)',
              transition: 'width var(--sf-dur-slow) var(--sf-ease-swift)',
            }}
          />
        </div>
      ) : null}
      {showFooter ? (
        <div style={FOOTER_STYLE}>
          {cost !== undefined ? <span>${cost}</span> : null}
          {cost !== undefined && elapsed !== undefined ? <span>·</span> : null}
          {elapsed !== undefined ? <span>{elapsed}s</span> : null}
        </div>
      ) : null}
    </Card>
  );
}
