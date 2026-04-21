import type { Metadata } from 'next';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, desc, eq, gte } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { teams, teamMembers, teamRuns } from '@/lib/db/schema';
import { EmptyState } from '@/components/ui/empty-state';
import { TeamHeader } from './_components/team-header';
import { MemberCard, type TeamMemberStatus } from './_components/member-card';

export const metadata: Metadata = {
  title: 'Your AI Team',
  description:
    'The AI marketing team that plans and executes your launch, working together in the background.',
};

export const dynamic = 'force-dynamic';

/**
 * Returns the UTC timestamp for 00:00 on Monday of the current ISO week.
 * Used to aggregate `team_runs.total_cost_usd` for the "this week" figure
 * on the team header.
 */
function startOfIsoWeek(now: Date = new Date()): Date {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const day = d.getUTCDay();
  // Sunday=0 → back up 6; Monday=1 → back up 0; else → back up day-1
  const diff = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

/**
 * `/team` — Phase D Day 1 read-only scaffold.
 *
 * Server-renders a snapshot of the user's team: header + member grid.
 * Real-time updates (SSE) arrive in Day 2. This page intentionally does
 * NOT expose any "customize team" controls — team composition is
 * product-decided (spec §2 / D6).
 */
export default async function TeamPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');
  const userId = session.user.id;

  const teamRow = await db
    .select({
      id: teams.id,
      name: teams.name,
      createdAt: teams.createdAt,
    })
    .from(teams)
    .where(eq(teams.userId, userId))
    .orderBy(desc(teams.createdAt))
    .limit(1);

  if (teamRow.length === 0) {
    return <NoTeamYet />;
  }

  const team = teamRow[0];

  const [members, activeRunRows, lastRunRows, weekRuns] = await Promise.all([
    db
      .select({
        id: teamMembers.id,
        agentType: teamMembers.agentType,
        displayName: teamMembers.displayName,
        status: teamMembers.status,
        lastActiveAt: teamMembers.lastActiveAt,
      })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, team.id))
      .orderBy(teamMembers.createdAt),
    db
      .select({
        id: teamRuns.id,
        startedAt: teamRuns.startedAt,
        trigger: teamRuns.trigger,
      })
      .from(teamRuns)
      .where(and(eq(teamRuns.teamId, team.id), eq(teamRuns.status, 'running')))
      .limit(1),
    db
      .select({
        status: teamRuns.status,
        completedAt: teamRuns.completedAt,
      })
      .from(teamRuns)
      .where(eq(teamRuns.teamId, team.id))
      .orderBy(desc(teamRuns.startedAt))
      .limit(1),
    db
      .select({ costUsd: teamRuns.totalCostUsd })
      .from(teamRuns)
      .where(
        and(
          eq(teamRuns.teamId, team.id),
          gte(teamRuns.startedAt, startOfIsoWeek()),
        ),
      ),
  ]);

  const activeRun = activeRunRows[0]
    ? {
        runId: activeRunRows[0].id,
        startedAt: activeRunRows[0].startedAt,
        trigger: activeRunRows[0].trigger,
      }
    : null;

  const lastRun =
    activeRun || lastRunRows.length === 0
      ? null
      : {
          status: lastRunRows[0].status,
          completedAt: lastRunRows[0].completedAt,
        };

  const totalCostThisWeekUsd = weekRuns.reduce((sum, row) => {
    const raw = row.costUsd;
    if (raw === null || raw === undefined) return sum;
    const parsed = typeof raw === 'string' ? Number.parseFloat(raw) : Number(raw);
    return Number.isFinite(parsed) ? sum + parsed : sum;
  }, 0);

  const mainStyle: CSSProperties = {
    padding: 'var(--sf-space-2xl) var(--sf-space-xl)',
    maxWidth: 1200,
    margin: '0 auto',
  };

  const gridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: 'var(--sf-space-lg)',
  };

  return (
    <main style={mainStyle}>
      <TeamHeader
        teamName={team.name}
        activeRun={activeRun}
        lastRun={lastRun}
        totalCostThisWeekUsd={totalCostThisWeekUsd}
      />
      {members.length === 0 ? (
        <EmptyState
          title="Your team is still being provisioned."
          hint="Give it a moment. If this persists, try refreshing."
        />
      ) : (
        <section aria-label="Team members" style={gridStyle}>
          {members.map((m) => (
            <MemberCard
              key={m.id}
              memberId={m.id}
              agentType={m.agentType}
              displayName={m.displayName}
              status={m.status as TeamMemberStatus}
              lastActiveAt={m.lastActiveAt}
            />
          ))}
        </section>
      )}
    </main>
  );
}

function NoTeamYet() {
  const wrap: CSSProperties = {
    padding: 'var(--sf-space-4xl) var(--sf-space-xl)',
    maxWidth: 640,
    margin: '0 auto',
  };
  const cta: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 40,
    padding: '0 16px',
    borderRadius: 'var(--sf-radius-md)',
    background: 'var(--sf-accent)',
    color: 'var(--sf-fg-on-dark-1)',
    fontSize: 'var(--sf-text-base)',
    fontWeight: 500,
    textDecoration: 'none',
  };
  return (
    <main style={wrap}>
      <EmptyState
        title="Your team is ready."
        hint="Ship your first plan to get started."
        action={
          <Link href="/onboarding" style={cta}>
            Start onboarding
          </Link>
        }
      />
    </main>
  );
}
