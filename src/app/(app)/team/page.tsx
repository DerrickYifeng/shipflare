import type { Metadata } from 'next';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  teams,
  teamMembers,
  teamRuns,
  teamMessages,
  teamTasks,
  teamConversations,
  products,
} from '@/lib/db/schema';
import { EmptyState } from '@/components/ui/empty-state';
import { getTeamBudgetSnapshot } from '@/lib/team-budget';
import { ensureKickoffEnqueued } from '@/lib/team-kickoff';
import type {
  TeamActivityMessage,
  TeamMessageType,
} from '@/hooks/use-team-events';
import { TeamDesk, type TeamDeskMember } from './_components/team-desk';
import type { BudgetSegment } from './_components/token-budget';
import type {
  TaskLookup,
  TaskLookupEntry,
  TeamRunLookup,
  TeamRunMeta,
} from './_components/conversation-reducer';
import type { ConversationMeta } from './_components/conversation-meta';

export const metadata: Metadata = {
  title: 'My AI Team',
  description:
    'Brief your Team Lead once. The AI team plans, drafts, and schedules — you approve every ship.',
};

export const dynamic = 'force-dynamic';

const INITIAL_MESSAGE_WINDOW = 100;

function startOfIsoWeek(now: Date = new Date()): Date {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

function isoOrNull(value: Date | null): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

/**
 * Pull a short human-readable summary off a spawn's `team_tasks.output`.
 * Subagents that use StructuredOutput land a `{ status, summary, ... }`
 * object in this column; free-form agents may land plain text. Anything
 * else (null, arrays, raw objects without a `summary` key) returns null —
 * the dispatch card skips the summary block rather than printing JSON.
 */
function extractOutputSummary(output: unknown): string | null {
  if (typeof output === 'string') {
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const obj = output as Record<string, unknown>;
    const summary = obj['summary'];
    if (typeof summary === 'string' && summary.trim().length > 0) {
      return summary.trim();
    }
    const notes = obj['notes'];
    if (typeof notes === 'string' && notes.trim().length > 0) {
      return notes.trim();
    }
  }
  return null;
}

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ conv?: string; from?: string }>;
}) {
  const sp = await searchParams;
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

  // First-visit kickoff bootstrap. Idempotent: a row in `team_runs` with
  // `trigger='kickoff'` (any status) short-circuits this on every
  // subsequent render. We resolve the product synchronously before
  // firing because the kickoff playbook needs `productId` for the
  // search-strategist + run_discovery_scan tools — both pull deps off
  // the team-run worker context. See `src/lib/team-kickoff.ts`.
  const [productRow] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .orderBy(desc(products.createdAt))
    .limit(1);
  if (productRow) {
    // Fire-and-forget — the kickoff helper is itself idempotent and
    // awaiting it just delays the server render by a few ms (one
    // SELECT, one INSERT, one job enqueue). On re-render after the
    // kickoff exists it's a single SELECT.
    await ensureKickoffEnqueued({
      userId,
      productId: productRow.id,
      teamId: team.id,
    });
  }

  const [
    members,
    activeRunRows,
    lastRunRows,
    rawMessages,
    memberCostRows,
    taskRows,
    conversationRows,
  ] = await Promise.all([
    db
      .select({
        id: teamMembers.id,
        agentType: teamMembers.agentType,
        displayName: teamMembers.displayName,
        status: teamMembers.status,
        lastActiveAt: teamMembers.lastActiveAt,
        createdAt: teamMembers.createdAt,
      })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, team.id))
      .orderBy(teamMembers.createdAt),
    db
      .select({
        id: teamRuns.id,
        startedAt: teamRuns.startedAt,
        totalTurns: teamRuns.totalTurns,
      })
      .from(teamRuns)
      .where(and(eq(teamRuns.teamId, team.id), eq(teamRuns.status, 'running')))
      .limit(1),
    db
      .select({
        status: teamRuns.status,
        completedAt: teamRuns.completedAt,
        totalTurns: teamRuns.totalTurns,
      })
      .from(teamRuns)
      .where(eq(teamRuns.teamId, team.id))
      .orderBy(desc(teamRuns.startedAt))
      .limit(1),
    db
      .select({
        id: teamMessages.id,
        runId: teamMessages.runId,
        conversationId: teamMessages.conversationId,
        teamId: teamMessages.teamId,
        fromMemberId: teamMessages.fromMemberId,
        toMemberId: teamMessages.toMemberId,
        type: teamMessages.type,
        content: teamMessages.content,
        metadata: teamMessages.metadata,
        createdAt: teamMessages.createdAt,
      })
      .from(teamMessages)
      .leftJoin(teamRuns, eq(teamRuns.id, teamMessages.runId))
      .where(
        and(
          eq(teamMessages.teamId, team.id),
          or(
            isNull(teamMessages.runId),
            ne(teamRuns.trigger, 'onboarding'),
          ),
        ),
      )
      .orderBy(desc(teamMessages.createdAt))
      .limit(INITIAL_MESSAGE_WINDOW),
    db
      .select({
        memberId: teamTasks.memberId,
        sum: sql<string>`coalesce(sum(${teamTasks.costUsd}), 0)`.as('sum'),
      })
      .from(teamTasks)
      .innerJoin(teamRuns, eq(teamRuns.id, teamTasks.runId))
      .where(
        and(
          eq(teamRuns.teamId, team.id),
          gte(teamRuns.startedAt, startOfIsoWeek()),
        ),
      )
      .groupBy(teamTasks.memberId),
    db
      .select({
        id: teamTasks.id,
        memberId: teamTasks.memberId,
        status: teamTasks.status,
        description: teamTasks.description,
        startedAt: teamTasks.startedAt,
        completedAt: teamTasks.completedAt,
        output: teamTasks.output,
        input: teamTasks.input,
      })
      .from(teamTasks)
      .innerJoin(teamRuns, eq(teamRuns.id, teamTasks.runId))
      .where(
        and(
          eq(teamRuns.teamId, team.id),
          ne(teamRuns.trigger, 'onboarding'),
        ),
      )
      .orderBy(desc(teamTasks.startedAt))
      .limit(200),
    db
      .select({
        id: teamConversations.id,
        title: teamConversations.title,
        createdAt: teamConversations.createdAt,
        updatedAt: teamConversations.updatedAt,
      })
      .from(teamConversations)
      .where(eq(teamConversations.teamId, team.id))
      .orderBy(desc(teamConversations.updatedAt))
      .limit(100),
  ]);

  if (members.length === 0) {
    return (
      <main style={{ padding: 'var(--sf-space-2xl) var(--sf-space-xl)', maxWidth: 960, margin: '0 auto' }}>
        <EmptyState
          title="Your team is still being provisioned."
          hint="Give it a moment. If this persists, try refreshing."
        />
      </main>
    );
  }

  // Earliest-createdAt coordinator wins; any later duplicates fall into
  // the specialist list so they still render instead of disappearing.
  const coordinator = members.find((m) => m.agentType === 'coordinator') ?? null;
  const specialistsRaw = members.filter((m) => m.id !== coordinator?.id);

  const openTaskCountByMember = new Map<string, number>();
  for (const t of taskRows) {
    if (t.status === 'pending' || t.status === 'running') {
      openTaskCountByMember.set(
        t.memberId,
        (openTaskCountByMember.get(t.memberId) ?? 0) + 1,
      );
    }
  }

  const teamLead: TeamDeskMember | null = coordinator
    ? {
        id: coordinator.id,
        agentType: coordinator.agentType,
        displayName: coordinator.displayName,
        status: coordinator.status,
        taskCount: openTaskCountByMember.get(coordinator.id) ?? 0,
      }
    : null;

  const specialists: TeamDeskMember[] = specialistsRaw.map((m) => ({
    id: m.id,
    agentType: m.agentType,
    displayName: m.displayName,
    status: m.status,
    taskCount: openTaskCountByMember.get(m.id) ?? 0,
  }));

  const memberCostMap = new Map<string, number>();
  for (const row of memberCostRows) {
    memberCostMap.set(row.memberId, Number(row.sum) || 0);
  }

  const budgetSnap = await getTeamBudgetSnapshot(team.id);

  const budgetSegments: BudgetSegment[] = specialists.map((m) => ({
    memberId: m.id,
    agentType: m.agentType,
    displayName: m.displayName,
    spentUsd: memberCostMap.get(m.id) ?? 0,
  }));
  if (teamLead) {
    const leadSpend = memberCostMap.get(teamLead.id) ?? 0;
    if (leadSpend > 0) {
      budgetSegments.unshift({
        memberId: teamLead.id,
        agentType: teamLead.agentType,
        displayName: teamLead.displayName,
        spentUsd: leadSpend,
      });
    }
  }

  const initialMessages: TeamActivityMessage[] = [...rawMessages]
    .reverse()
    .map((m) => ({
      id: m.id,
      runId: m.runId,
      conversationId: m.conversationId ?? null,
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
        m.createdAt instanceof Date
          ? m.createdAt.toISOString()
          : String(m.createdAt),
    }));

  // Dual-key lookup: the coordinator's Task tool_call metadata carries
  // the LLM-issued `toolUseId`, but `team_tasks` rows are keyed by a
  // server-generated UUID — two different ids that point at the same
  // logical spawn. The worker stashes the toolUseId into
  // `team_tasks.input.toolUseId` (see AgentTool.recordTaskStart), so
  // we index the same entry under both keys here and the reducer can
  // join on whichever id is available. Without this the UI defaults
  // every dispatched subtask to QUEUED because lookups always miss.
  const taskLookup: TaskLookup = (() => {
    const map = new Map<string, TaskLookupEntry>();
    for (const t of taskRows) {
      const entry: TaskLookupEntry = {
        id: t.id,
        status: t.status,
        description: t.description ?? null,
        startedAt: isoOrNull(t.startedAt),
        completedAt: isoOrNull(t.completedAt),
        outputSummary: extractOutputSummary(t.output),
      };
      map.set(t.id, entry);
      const inputObj =
        t.input && typeof t.input === 'object' && !Array.isArray(t.input)
          ? (t.input as Record<string, unknown>)
          : null;
      const toolUseId = inputObj?.['toolUseId'];
      if (typeof toolUseId === 'string' && toolUseId.length > 0) {
        map.set(toolUseId, entry);
      }
    }
    return map;
  })();

  const runIds = Array.from(
    new Set(
      rawMessages
        .map((m) => m.runId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );

  const runRows = runIds.length
    ? await db
        .select({
          id: teamRuns.id,
          trigger: teamRuns.trigger,
          goal: teamRuns.goal,
          status: teamRuns.status,
          startedAt: teamRuns.startedAt,
          completedAt: teamRuns.completedAt,
          conversationId: teamRuns.conversationId,
        })
        .from(teamRuns)
        .where(
          and(eq(teamRuns.teamId, team.id), inArray(teamRuns.id, runIds)),
        )
    : [];

  const runLookup: TeamRunLookup = (() => {
    const map = new Map<string, TeamRunMeta>();
    for (const r of runRows) {
      map.set(r.id, {
        id: r.id,
        trigger: r.trigger,
        goal: r.goal ?? null,
        status: r.status,
        startedAt:
          r.startedAt instanceof Date
            ? r.startedAt.toISOString()
            : String(r.startedAt),
        completedAt: isoOrNull(r.completedAt),
        conversationId: r.conversationId ?? null,
      });
    }
    return map;
  })();

  // ChatGPT-style sidebar: just the conversation list sorted by
  // updatedAt desc. No per-row status — every thread is always
  // clickable and continuable.
  const conversations: ConversationMeta[] = conversationRows.map((c) => ({
    id: c.id,
    title: c.title,
    createdAt:
      c.createdAt instanceof Date
        ? c.createdAt.toISOString()
        : String(c.createdAt),
    updatedAt:
      c.updatedAt instanceof Date
        ? c.updatedAt.toISOString()
        : String(c.updatedAt),
  }));

  const requestedConv = typeof sp.conv === 'string' ? sp.conv : null;
  const initialConversationId =
    (requestedConv && conversations.find((c) => c.id === requestedConv)?.id) ??
    conversations[0]?.id ??
    null;
  const fromOnboarding = sp.from === 'onboarding';

  const activeRun = activeRunRows[0] ?? null;
  const lastRun = !activeRun && lastRunRows[0] ? lastRunRows[0] : null;
  const isLive = Boolean(activeRun);

  const draftsInFlight = taskRows.filter(
    (t) => t.status === 'pending' || t.status === 'running',
  ).length;
  const inReview = members.filter(
    (m) => m.status === 'waiting_approval',
  ).length;
  const approvedReady = taskRows.filter(
    (t) => t.status === 'completed',
  ).length;

  let leadMessage: string;
  if (activeRun) {
    leadMessage = 'Team Lead is active.';
  } else if (lastRun?.status === 'failed') {
    leadMessage = 'Team Lead paused after last run failed.';
  } else if (lastRun?.status === 'completed') {
    leadMessage = 'Team Lead finished the last run.';
  } else {
    leadMessage = 'Team Lead is idle. Brief them below to start.';
  }

  const turns = activeRun?.totalTurns ?? lastRun?.totalTurns ?? 0;

  return (
    <TeamDesk
      teamId={team.id}
      coordinatorId={coordinator?.id ?? null}
      teamLead={teamLead}
      specialists={specialists}
      initialMessages={initialMessages}
      spentUsd={budgetSnap.spentUsd}
      weeklyBudgetUsd={budgetSnap.weeklyBudgetUsd}
      budgetSegments={budgetSegments}
      activeRunId={activeRun?.id ?? null}
      activeRunStartedAt={isoOrNull(activeRun?.startedAt ?? null)}
      isLive={isLive}
      leadMessage={leadMessage}
      draftsInFlight={draftsInFlight}
      inReview={inReview}
      approvedReady={approvedReady}
      turns={turns}
      taskLookup={taskLookup}
      runLookup={runLookup}
      conversations={conversations}
      initialConversationId={initialConversationId}
      fromOnboarding={fromOnboarding}
    />
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
