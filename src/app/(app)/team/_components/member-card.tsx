'use client';

import Link from 'next/link';
import { useState, type CSSProperties } from 'react';
import { Card } from '@/components/ui/card';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import {
  accentForAgentType,
  avatarGradientForAgentType,
} from './agent-accent';

export type TeamMemberStatus =
  | 'idle'
  | 'active'
  | 'waiting_approval'
  | 'error';

export interface MemberCardProps {
  memberId: string;
  agentType: string;
  displayName: string;
  status: TeamMemberStatus | string;
  lastActiveAt: string | Date | null;
  currentTask?: string | null;
}

const STATUS_META: Record<
  TeamMemberStatus,
  { label: string; variant: BadgeVariant }
> = {
  idle: { label: 'Idle', variant: 'default' },
  active: { label: 'Active', variant: 'accent' },
  waiting_approval: { label: 'Waiting', variant: 'warning' },
  error: { label: 'Error', variant: 'error' },
};

function isTeamMemberStatus(value: string): value is TeamMemberStatus {
  return (
    value === 'idle' ||
    value === 'active' ||
    value === 'waiting_approval' ||
    value === 'error'
  );
}

function relativeTime(input: string | Date | null): string {
  if (!input) return 'never';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return 'never';
  const ms = Date.now() - d.getTime();
  if (ms < 0) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function initials(displayName: string): string {
  const trimmed = displayName.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function MemberCard({
  memberId,
  agentType,
  displayName,
  status,
  lastActiveAt,
  currentTask,
}: MemberCardProps) {
  const statusKey: TeamMemberStatus = isTeamMemberStatus(status)
    ? status
    : 'idle';
  const meta = STATUS_META[statusKey];
  const accent = accentForAgentType(agentType);
  const [hover, setHover] = useState(false);

  const avatar: CSSProperties = {
    width: 56,
    height: 56,
    borderRadius: 'var(--sf-radius-full)',
    background: avatarGradientForAgentType(agentType),
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--sf-fg-on-dark-1)',
    fontFamily: 'var(--sf-font-display)',
    fontSize: 'var(--sf-text-lg)',
    fontWeight: 600,
    letterSpacing: 0.2,
    flexShrink: 0,
    boxShadow: '0 6px 16px rgba(0, 0, 0, 0.08)',
  };

  const linkStyle: CSSProperties = {
    display: 'block',
    textDecoration: 'none',
    color: 'inherit',
    borderRadius: 'var(--sf-radius-xl)',
    outline: 'none',
  };

  const cardStyle: CSSProperties = {
    transition:
      'box-shadow 200ms var(--sf-ease-swift, ease-out), transform 200ms var(--sf-ease-swift, ease-out)',
    cursor: 'pointer',
    boxShadow: hover
      ? 'var(--sf-shadow-card-hover, 0 12px 28px rgba(0, 0, 0, 0.10))'
      : undefined,
    transform: hover ? 'translateY(-1px)' : undefined,
  };

  const headerRow: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
  };

  const nameStack: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
    flex: 1,
  };

  const nameStyle: CSSProperties = {
    fontSize: 'var(--sf-text-h3)',
    fontWeight: 600,
    color: 'var(--sf-fg-1)',
    letterSpacing: 'var(--sf-track-tight, -0.01em)',
    lineHeight: 1.1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  const typeStyle: CSSProperties = {
    fontSize: 'var(--sf-text-xs)',
    color: 'var(--sf-fg-3)',
    fontFamily: 'var(--sf-font-mono)',
    textTransform: 'lowercase',
    letterSpacing: 0.4,
  };

  const metaRow: CSSProperties = {
    marginTop: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  };

  const taskStyle: CSSProperties = {
    marginTop: 12,
    fontSize: 'var(--sf-text-sm)',
    color: 'var(--sf-fg-2)',
    lineHeight: 1.4,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  };

  const timeStyle: CSSProperties = {
    fontSize: 'var(--sf-text-xs)',
    color: 'var(--sf-fg-3)',
    fontVariantNumeric: 'tabular-nums',
  };

  const showTask = statusKey === 'active' && currentTask?.trim();

  // Use the agent's semantic accent on the card stripe — it's always
  // present, just dimmer when the member is idle so we don't paint the
  // whole grid rainbow-bright. The Card's accent prop takes a token name
  // like 'accent' | 'success' | 'warning', which the agent-accent map
  // surfaces via `badgeVariant` (a 1:1 correspondence).
  const cardAccent = accent?.badgeVariant;

  return (
    <Link
      href={`/team/${memberId}`}
      style={linkStyle}
      aria-label={`${displayName} — ${meta.label}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      data-testid={`member-card-${agentType}`}
    >
      <Card style={cardStyle} accent={cardAccent}>
        <div style={headerRow}>
          <div style={avatar} aria-hidden="true">
            {initials(displayName)}
          </div>
          <div style={nameStack}>
            <div style={nameStyle}>{displayName}</div>
            <div style={typeStyle}>{agentType}</div>
          </div>
        </div>

        {showTask ? <p style={taskStyle}>{currentTask}</p> : null}

        <div style={metaRow}>
          <Badge variant={meta.variant}>{meta.label}</Badge>
          <span style={timeStyle} aria-label="Last active">
            {relativeTime(lastActiveAt)}
          </span>
        </div>
      </Card>
    </Link>
  );
}
