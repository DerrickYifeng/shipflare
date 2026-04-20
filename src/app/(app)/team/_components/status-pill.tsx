/**
 * Compact mono status badge used under each agent's name pill in the
 * isometric scene. Separate from the shared `AgentCard.status` label so we
 * can render the prototype's seven-state vocabulary
 * (searching/drafting/reviewing/posting/blocked/walking/idle).
 */

import type { CSSProperties } from 'react';
import { StatusDot } from '@/components/ui/status-dot';
import { STATUS_META, type SceneStatus } from './agent-roster';

export interface StatusPillProps {
  status: SceneStatus;
}

const TONE_COLOR: Record<(typeof STATUS_META)[SceneStatus]['tone'], string> = {
  dim: 'var(--sf-fg-3)',
  signal: 'var(--sf-link)',
  flare: 'var(--sf-link)',
  success: 'var(--sf-success-ink)',
  danger: 'var(--sf-error-ink)',
};

const BASE_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '2px 7px',
  borderRadius: 'var(--sf-radius-pill)',
  background: 'var(--sf-bg-primary)',
  border: '1px solid var(--sf-border-subtle)',
  boxShadow: '0 1px 2px oklch(20% 0 0 / 0.08)',
  fontFamily: 'var(--sf-font-mono)',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 'var(--sf-track-mono)',
  whiteSpace: 'nowrap',
};

export function StatusPill({ status }: StatusPillProps) {
  const meta = STATUS_META[status] ?? STATUS_META.idle;
  const style: CSSProperties = { ...BASE_STYLE, color: TONE_COLOR[meta.tone] };
  return (
    <div style={style}>
      <StatusDot state={meta.dot} size={5} />
      {meta.label}
    </div>
  );
}
