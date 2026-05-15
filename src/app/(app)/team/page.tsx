import type { Metadata } from 'next';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  teams,
  teamMembers,
  agentRuns,
  teamMessages,
  teamConversations,
  products,
} from '@/lib/db/schema';
import { EmptyState } from '@/components/ui/empty-state';
import { ensureKickoffEnqueued } from '@/lib/team-kickoff';
import {
  publicAgentLabel,
  redactMessageRowForClient,
} from '@/lib/team/redact-for-client';
import type {
  TeamActivityMessage,
  TeamMessageType,
} from '@/hooks/use-team-events';
import { TeamDesk, type TeamDeskMember } from './_components/team-desk';
import type {
  AgentRunStatus,
  AgentRunStatusMap,
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

function isoOrNull(value: Date | null): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function isAgentRunStatusValue(v: string): v is AgentRunStatus['status'] {
  return (
    v === 'queued' ||
    v === 'running' ||
    v === 'sleeping' ||
    v === 'resuming' ||
    v === 'completed' ||
    v === 'failed' ||
    v === 'killed'
  );
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
  // discovery-agent deps — all pulled off the team-run worker context.
  // See `src/lib/team-kickoff.ts`.
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
    agentRunRows,
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
    // Phase E retired team_runs as the source of truth for "is the lead
    // currently running"; the lead's row in `agent_runs`
    // (agentDefName='coordinator') now carries that state. We synthesize
    // `id`/`startedAt` so downstream JSX doesn't have to special-case the
    // shape change. Fields that no longer have a 1:1 source on agent_runs
    // (totalTurns) are left unset; consumers default to 0 — see
    // TODO UI-B markers below.
    db
      .select({
        id: agentRuns.id,
        startedAt: agentRuns.lastActiveAt,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.teamId, team.id),
          eq(agentRuns.agentDefName, 'coordinator'),
          inArray(agentRuns.status, ['running', 'resuming']),
        ),
      )
      .limit(1),
    // "Last run" derives from the most recent terminal team_messages
    // event (completion / error). When a terminal event is missing
    // (legacy gap during the cutover window), the page falls back to
    // the lead's lastActiveAt as a soft signal.
    db
      .select({
        type: teamMessages.type,
        completedAt: teamMessages.createdAt,
      })
      .from(teamMessages)
      .where(
        and(
          eq(teamMessages.teamId, team.id),
          inArray(teamMessages.type, ['completion', 'error']),
        ),
      )
      .orderBy(desc(teamMessages.createdAt))
      .limit(1),
    // `team_messages.runId` is NULL for new flows (Phase E). The
    // teamRuns join we used to do for onboarding-trigger filtering
    // is gone; the trigger discriminator now lives on
    // `team_messages.metadata.trigger`. Filter onboarding kickoffs
    // there instead.
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
      .where(
        and(
          eq(teamMessages.teamId, team.id),
          sql`(${teamMessages.metadata}->>'trigger') IS DISTINCT FROM 'onboarding'`,
        ),
      )
      .orderBy(desc(teamMessages.createdAt))
      .limit(INITIAL_MESSAGE_WINDOW),
    // Recent agent_runs for this team — the SSOT for dispatch lifecycle.
    // Returns every teammate spawn (parent_tool_use_id present means it
    // was launched via the Task tool; null means it was the lead's own
    // run). Used to seed the AgentRunStatusMap so the UI's dispatch cards
    // show truthful status from first paint. Limit caps the SSR payload —
    // older rows that aren't visible in the conversation window don't
    // need to be in the map.
    db
      .select({
        id: agentRuns.id,
        memberId: agentRuns.memberId,
        status: agentRuns.status,
        parentToolUseId: agentRuns.parentToolUseId,
        spawnedAt: agentRuns.spawnedAt,
        lastActiveAt: agentRuns.lastActiveAt,
      })
      .from(agentRuns)
      .where(eq(agentRuns.teamId, team.id))
      .orderBy(desc(agentRuns.spawnedAt))
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

  // Count in-flight agent_runs per teammate so the roster sidebar can show
  // a "2 active" badge. Anything not in a terminal state counts as open.
  const openTaskCountByMember = new Map<string, number>();
  for (const r of agentRunRows) {
    if (
      r.status === 'queued' ||
      r.status === 'running' ||
      r.status === 'resuming' ||
      r.status === 'sleeping'
    ) {
      openTaskCountByMember.set(
        r.memberId,
        (openTaskCountByMember.get(r.memberId) ?? 0) + 1,
      );
    }
  }

  // Redact agentType at the SSR → client boundary so the founder UI
  // never sees raw architectural names (`coordinator`,
  // `social-media-manager`). The /api/team/activity and
  // /api/team/[teamId]/teammates routes already do this; symmetry here
  // keeps SSR and live SSE / fetch results consistent. Internal lookups
  // above (find coordinator by agentType === 'coordinator') still
  // operate on the raw value so the team-lead resolution stays correct.
  const teamLead: TeamDeskMember | null = coordinator
    ? {
        id: coordinator.id,
        agentType: publicAgentLabel(coordinator.agentType),
        displayName: coordinator.displayName,
        status: coordinator.status,
        taskCount: openTaskCountByMember.get(coordinator.id) ?? 0,
      }
    : null;

  const specialists: TeamDeskMember[] = specialistsRaw.map((m) => ({
    id: m.id,
    agentType: publicAgentLabel(m.agentType),
    displayName: m.displayName,
    status: m.status,
    taskCount: openTaskCountByMember.get(m.id) ?? 0,
  }));

  // Pass every team_messages row through the same redactor that the
  // /api/team/* routes use, so the SSR/RSC payload matches what the
  // live SSE feed and active fetches return. Without this, kickoff
  // rows leak the raw goal text ("First-visit kickoff for ShipFlare.
  // Strategic path... Follow your kickoff playbook end-to-end (plan
  // → social-media-manager): ...") in the initial render even though
  // every subsequent fetch is clean.
  const initialMessages: TeamActivityMessage[] = [...rawMessages]
    .reverse()
    .map((m) => {
      const redacted = redactMessageRowForClient({
        id: m.id,
        runId: m.runId,
        teamId: m.teamId,
        conversationId: m.conversationId ?? null,
        fromMemberId: m.fromMemberId,
        toMemberId: m.toMemberId,
        type: m.type,
        content: m.content,
        metadata: m.metadata as Record<string, unknown> | null,
        createdAt: m.createdAt,
      });
      return {
        id: redacted.id,
        runId: redacted.runId,
        conversationId: redacted.conversationId ?? null,
        teamId: redacted.teamId,
        from: redacted.fromMemberId ?? null,
        to: redacted.toMemberId ?? null,
        type: redacted.type as TeamMessageType,
        content: redacted.content,
        metadata: redacted.metadata,
        createdAt:
          redacted.createdAt instanceof Date
            ? redacted.createdAt.toISOString()
            : String(redacted.createdAt),
      };
    });

  // AgentRunStatusMap: `agent_runs` is the single source of truth for
  // dispatch lifecycle. The reducer's buildDelegationTask joins each
  // Task tool_call to its spawned row by `parentToolUseId === toolUseId`,
  // reads `status`, and renders the dispatch card with the truthful state
  // (queued → running → done / failed / killed). The map is also kept
  // fresh live through `agent_status_change` SSE events — see
  // `applyStatusChanges` in conversation-reducer.ts.
  const agentRunStatus: AgentRunStatusMap = (() => {
    const map = new Map<string, AgentRunStatus>();
    for (const r of agentRunRows) {
      if (!isAgentRunStatusValue(r.status)) continue;
      map.set(r.id, {
        agentId: r.id,
        status: r.status,
        parentToolUseId: r.parentToolUseId,
        spawnedAt: isoOrNull(r.spawnedAt),
        lastActiveAt: isoOrNull(r.lastActiveAt),
        // outputSummary is back-filled by the reducer from the matching
        // task_notification team_messages row — agent_runs itself doesn't
        // store the human-readable summary text.
        outputSummary: null,
      });
    }
    return map;
  })();

  // TODO UI-B: `team_messages.runId` is NULL for new (Phase E+) flows,
  // so the runId→TeamRunMeta lookup is empty in practice. The conversation
  // reducer + child components still accept the prop for legacy rendering
  // paths (session dividers grouping by run); UI-B will replace those with
  // agent_runs + per-conversation turn boundaries. Until then we pass an
  // empty map so the prop type stays stable and any legacy render paths
  // simply skip the run divider.
  const runLookup: TeamRunLookup = new Map<string, TeamRunMeta>();

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

  const draftsInFlight = agentRunRows.filter(
    (r) =>
      r.status === 'queued' ||
      r.status === 'running' ||
      r.status === 'resuming' ||
      r.status === 'sleeping',
  ).length;
  const inReview = members.filter(
    (m) => m.status === 'waiting_approval',
  ).length;
  const approvedReady = agentRunRows.filter(
    (r) => r.status === 'completed',
  ).length;

  let leadMessage: string;
  if (activeRun) {
    leadMessage = 'Team Lead is active.';
  } else if (lastRun?.type === 'error') {
    leadMessage = 'Team Lead paused after last run failed.';
  } else if (lastRun?.type === 'completion') {
    leadMessage = 'Team Lead finished the last run.';
  } else {
    leadMessage = 'Team Lead is idle. Brief them below to start.';
  }

  // TODO UI-B: `totalTurns` was a column on team_runs that no longer
  // exists. A plausible derived equivalent is "count of agent_text_stop
  // messages from the lead since the most recent founder user_prompt",
  // but that needs another query and the StatusBanner doesn't currently
  // surface it (no `turns` prop on StatusBanner). Pass 0 to keep the
  // <TeamDesk> prop type stable; downstream consumers either render 0
  // or hide the field.
  const turns = 0;

  return (
    <TeamDesk
      teamId={team.id}
      coordinatorId={coordinator?.id ?? null}
      teamLead={teamLead}
      specialists={specialists}
      initialMessages={initialMessages}
      activeRunId={activeRun?.id ?? null}
      activeRunStartedAt={isoOrNull(activeRun?.startedAt ?? null)}
      isLive={isLive}
      leadMessage={leadMessage}
      draftsInFlight={draftsInFlight}
      inReview={inReview}
      approvedReady={approvedReady}
      turns={turns}
      agentRunStatus={agentRunStatus}
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
