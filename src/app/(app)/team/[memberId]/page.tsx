import type { Metadata } from 'next';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { and, asc, eq, or } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamMembers, teamMessages } from '@/lib/db/schema';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import {
  ActivityLog,
  type ActivityLogMemberRef,
} from '../_components/activity-log';
import type {
  TeamActivityMessage,
  TeamMessageType,
} from '@/hooks/use-team-events';

export const metadata: Metadata = {
  title: 'Team member · ShipFlare',
};

export const dynamic = 'force-dynamic';

// Keep the initial server-rendered window small so hydration is cheap;
// the SSE snapshot (up to 200 rows) rehydrates older history on mount.
const INITIAL_MESSAGE_WINDOW = 100;

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  idle: 'default',
  active: 'accent',
  waiting_approval: 'warning',
  error: 'error',
};

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  active: 'Active',
  waiting_approval: 'Waiting',
  error: 'Error',
};

const AGENT_ROLE_BLURB: Record<string, string> = {
  coordinator:
    'Chief of Staff. Receives your goals, delegates to specialists, composes final outputs.',
  'growth-strategist':
    'Head of Growth. Designs the 30-day narrative arc, milestones, and content pillars.',
  'content-planner':
    'Head of Content. Turns the strategic path into a weekly plan of posts and tasks.',
};

function avatarGradient(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 48) % 360;
  return `linear-gradient(135deg, hsl(${h1} 68% 72%), hsl(${h2} 62% 58%))`;
}

function initials(displayName: string): string {
  const trimmed = displayName.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

interface TeamMemberPageProps {
  params: Promise<{ memberId: string }>;
}

/**
 * `/team/[memberId]` — Phase D Day 2. Server-renders an initial snapshot
 * of the member's activity (messages where they're sender or recipient),
 * hands it to a client `ActivityLog` that swaps to the live SSE feed on
 * mount. Direct-messaging UI is intentionally out of scope here — that
 * lands in Day 3 (Task #13).
 */
export default async function TeamMemberPage({ params }: TeamMemberPageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const userId = session.user.id;

  const { memberId } = await params;

  // Resolve the member + ownership + team context in one go.
  const memberRows = await db
    .select({
      id: teamMembers.id,
      teamId: teamMembers.teamId,
      agentType: teamMembers.agentType,
      displayName: teamMembers.displayName,
      status: teamMembers.status,
      lastActiveAt: teamMembers.lastActiveAt,
      teamOwnerId: teams.userId,
      teamName: teams.name,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.id, memberId))
    .limit(1);

  if (memberRows.length === 0 || memberRows[0].teamOwnerId !== userId) {
    notFound();
  }

  const member = memberRows[0];

  const [roster, initialMessageRows] = await Promise.all([
    db
      .select({
        id: teamMembers.id,
        agentType: teamMembers.agentType,
        displayName: teamMembers.displayName,
      })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, member.teamId))
      .orderBy(teamMembers.createdAt),
    db
      .select({
        id: teamMessages.id,
        runId: teamMessages.runId,
        teamId: teamMessages.teamId,
        fromMemberId: teamMessages.fromMemberId,
        toMemberId: teamMessages.toMemberId,
        type: teamMessages.type,
        content: teamMessages.content,
        metadata: teamMessages.metadata,
        createdAt: teamMessages.createdAt,
      })
      .from(teamMessages)
      .where(
        and(
          eq(teamMessages.teamId, member.teamId),
          or(
            eq(teamMessages.fromMemberId, memberId),
            eq(teamMessages.toMemberId, memberId),
          ),
        ),
      )
      .orderBy(asc(teamMessages.createdAt))
      .limit(INITIAL_MESSAGE_WINDOW),
  ]);

  const rosterRefs: ActivityLogMemberRef[] = roster.map((m) => ({
    id: m.id,
    agentType: m.agentType,
    displayName: m.displayName,
  }));

  const initialMessages: TeamActivityMessage[] = initialMessageRows.map((m) => ({
    id: m.id,
    runId: m.runId,
    teamId: m.teamId,
    from: m.fromMemberId,
    to: m.toMemberId,
    type: m.type as TeamMessageType,
    content: m.content,
    metadata:
      typeof m.metadata === 'object' && m.metadata !== null
        ? (m.metadata as Record<string, unknown>)
        : null,
    createdAt:
      m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
  }));

  const mainStyle: CSSProperties = {
    padding: 'var(--sf-space-2xl) var(--sf-space-xl)',
    maxWidth: 960,
    margin: '0 auto',
  };

  const breadcrumbStyle: CSSProperties = {
    fontSize: 'var(--sf-text-sm)',
    color: 'var(--sf-fg-3)',
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    marginBottom: 'var(--sf-space-base)',
  };

  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sf-space-lg)',
    paddingBottom: 'var(--sf-space-xl)',
    borderBottom: '1px solid var(--sf-border-subtle)',
    marginBottom: 'var(--sf-space-2xl)',
  };

  const avatarStyle: CSSProperties = {
    width: 72,
    height: 72,
    borderRadius: 'var(--sf-radius-full)',
    background: avatarGradient(member.agentType),
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--sf-fg-on-dark-1)',
    fontFamily: 'var(--sf-font-display)',
    fontSize: 'var(--sf-text-h2)',
    fontWeight: 600,
    flexShrink: 0,
    boxShadow: '0 6px 18px rgba(0, 0, 0, 0.10)',
  };

  const nameStack: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minWidth: 0,
  };

  const nameRow: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
    flexWrap: 'wrap',
  };

  const nameStyle: CSSProperties = {
    fontFamily: 'var(--sf-font-display)',
    fontSize: 'var(--sf-text-h1)',
    fontWeight: 600,
    color: 'var(--sf-fg-1)',
    letterSpacing: '-0.015em',
    margin: 0,
    lineHeight: 1.1,
  };

  const typeStyle: CSSProperties = {
    fontSize: 'var(--sf-text-sm)',
    color: 'var(--sf-fg-3)',
    fontFamily: 'var(--sf-font-mono)',
  };

  const blurbStyle: CSSProperties = {
    margin: 0,
    fontSize: 'var(--sf-text-base)',
    color: 'var(--sf-fg-2)',
    maxWidth: 560,
    lineHeight: 1.5,
  };

  const statusKey = member.status in STATUS_VARIANT ? member.status : 'idle';
  const statusVariant = STATUS_VARIANT[statusKey];
  const statusLabel = STATUS_LABEL[statusKey] ?? statusKey;
  const blurb =
    AGENT_ROLE_BLURB[member.agentType] ??
    `Specialist for ${member.agentType}.`;

  return (
    <main style={mainStyle}>
      <Link href="/team" style={breadcrumbStyle} aria-label="Back to team">
        ← {member.teamName}
      </Link>

      <header style={headerStyle}>
        <div style={avatarStyle} aria-hidden="true">
          {initials(member.displayName)}
        </div>
        <div style={nameStack}>
          <div style={nameRow}>
            <h1 style={nameStyle}>{member.displayName}</h1>
            <Badge variant={statusVariant}>{statusLabel}</Badge>
          </div>
          <span style={typeStyle}>{member.agentType}</span>
          <p style={blurbStyle}>{blurb}</p>
        </div>
      </header>

      <ActivityLog
        teamId={member.teamId}
        memberId={member.id}
        members={rosterRefs}
        initialMessages={initialMessages}
      />
    </main>
  );
}
