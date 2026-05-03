import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, and, isNull, isNotNull, asc } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  teams,
  teamMembers,
  teamMessages,
  teamTasks,
  users,
} from '@/lib/db/schema';

/**
 * /admin/team-runs/[runId] — Phase G rewrite (single-request detail).
 *
 * The `[runId]` URL param is now the user_prompt's `team_messages.id`
 * (the "request handle" replacing the dropped team_runs.id). Three
 * queries:
 *   1. Header — the user_prompt row + team / owner labels.
 *   2. Activity — every team_messages row whose runId = <param>,
 *      ordered ascending. Carries the response timeline (agent_text /
 *      tool_call / tool_result / thinking / etc.).
 *   3. Tasks — every team_tasks row whose runId = <param>, with
 *      teamMembers join for the spawned agent's display name.
 *
 * Renders the same Conversation / FoldedRow / KeyValue components as
 * the pre-Phase-G detail page (preserves the user's recent
 * "team-runs polish" work — see commit 02be710).
 *
 * Auth gated by src/app/(app)/admin/layout.tsx.
 */

interface PageProps {
  params: Promise<{ runId: string }>;
}

export default async function AdminTeamRunDetailPage({ params }: PageProps) {
  const { runId } = await params;

  // Query 1: header. Restrict to the user_prompt shape the list page uses
  // (founder→lead origin) so deep-linking to a non-request id (e.g. an
  // agent_text id) 404s cleanly instead of rendering a confusing header.
  const [request] = await db
    .select({
      requestId: teamMessages.id,
      teamId: teamMessages.teamId,
      teamName: teams.name,
      ownerEmail: users.email,
      goal: teamMessages.content,
      startedAt: teamMessages.createdAt,
      metadata: teamMessages.metadata,
    })
    .from(teamMessages)
    .leftJoin(teams, eq(teams.id, teamMessages.teamId))
    .leftJoin(users, eq(users.id, teams.userId))
    .where(
      and(
        eq(teamMessages.id, runId),
        eq(teamMessages.type, 'user_prompt'),
        eq(teamMessages.messageType, 'message'),
        isNull(teamMessages.fromMemberId),
        isNotNull(teamMessages.toAgentId),
      ),
    )
    .limit(1);

  if (!request) notFound();

  // Query 2: full activity. ASC + limit 500 — the same cap the original
  // page used; runs longer than 500 turns get a truncation badge.
  const activity = await db
    .select({
      id: teamMessages.id,
      fromMemberId: teamMessages.fromMemberId,
      toMemberId: teamMessages.toMemberId,
      type: teamMessages.type,
      messageType: teamMessages.messageType,
      content: teamMessages.content,
      metadata: teamMessages.metadata,
      summary: teamMessages.summary,
      createdAt: teamMessages.createdAt,
    })
    .from(teamMessages)
    .where(eq(teamMessages.runId, runId))
    .orderBy(asc(teamMessages.createdAt))
    .limit(500);

  // Query 3: spawned tasks for this request. team_tasks.runId now points
  // at the user_prompt.id (post-migration 0016) — same correlation as
  // the activity query above.
  const tasks = await db
    .select({
      id: teamTasks.id,
      parentTaskId: teamTasks.parentTaskId,
      memberId: teamTasks.memberId,
      agentType: teamMembers.agentType,
      displayName: teamMembers.displayName,
      description: teamTasks.description,
      status: teamTasks.status,
      costUsd: teamTasks.costUsd,
      turns: teamTasks.turns,
      startedAt: teamTasks.startedAt,
      completedAt: teamTasks.completedAt,
    })
    .from(teamTasks)
    .leftJoin(teamMembers, eq(teamMembers.id, teamTasks.memberId))
    .where(eq(teamTasks.runId, runId))
    .orderBy(asc(teamTasks.startedAt));

  // Build memberById from the tasks' member joins (the activity rows
  // carry fromMemberId but no display name; tasks carry both, so this
  // map covers any member referenced by either query).
  const memberById = new Map<string, { agentType: string; displayName: string }>();
  for (const task of tasks) {
    if (task.memberId && task.agentType && task.displayName) {
      memberById.set(task.memberId, {
        agentType: task.agentType,
        displayName: task.displayName,
      });
    }
  }

  // Derive header status with the same heuristic the list page uses
  // (errors → failed; recent activity → running; quiet → completed;
  // no activity → pending).
  const lastActivityAt =
    activity.length > 0
      ? activity[activity.length - 1].createdAt
      : null;
  const totalTurns = activity.filter((m) => m.type === 'agent_text').length;
  const errorCount = activity.filter(
    (m) =>
      m.type === 'tool_result' &&
      m.metadata != null &&
      typeof m.metadata === 'object' &&
      (m.metadata as { is_error?: unknown }).is_error === true,
  ).length;
  const status = deriveStatus({
    startedAt: request.startedAt,
    lastActivityAt,
    totalTurns,
    errorCount,
  });
  const durationMs =
    lastActivityAt && request.startedAt
      ? lastActivityAt.getTime() - request.startedAt.getTime()
      : null;

  return (
    <div>
      <Link
        href="/admin/team-runs"
        style={{
          display: 'inline-block',
          marginBottom: 18,
          fontSize: 12,
          color: 'var(--sf-fg-3)',
          textDecoration: 'none',
        }}
      >
        ← back to list
      </Link>

      <section style={sectionStyle()}>
        <h2 style={headingStyle()}>Request</h2>
        <dl style={dlStyle()}>
          <KeyValue
            k="Request ID"
            v={<code>{request.requestId}</code>}
          />
          <KeyValue
            k="Team"
            v={request.teamName ?? <code>{request.teamId}</code>}
          />
          {request.ownerEmail ? (
            <KeyValue k="Owner" v={request.ownerEmail} />
          ) : null}
          <KeyValue k="Status" v={status} />
          <KeyValue
            k="Started"
            v={request.startedAt ? request.startedAt.toISOString() : '—'}
          />
          <KeyValue
            k="Last activity"
            v={lastActivityAt ? lastActivityAt.toISOString() : '—'}
          />
          <KeyValue
            k="Duration"
            v={durationMs !== null ? formatDuration(durationMs) : '—'}
          />
          <KeyValue k="Total turns" v={totalTurns} />
        </dl>
        {request.goal && (
          <div
            style={{
              marginTop: 12,
              padding: '10px 12px',
              background: 'var(--sf-bg-secondary)',
              borderRadius: 6,
              fontSize: 12.5,
              lineHeight: 1.5,
              color: 'var(--sf-fg-2)',
              whiteSpace: 'pre-wrap',
            }}
          >
            <strong style={{ fontWeight: 500, color: 'var(--sf-fg-3)' }}>
              Goal:
            </strong>{' '}
            {request.goal}
          </div>
        )}
      </section>

      <section style={sectionStyle()}>
        <h2 style={headingStyle()}>Spawned tasks ({tasks.length})</h2>
        {tasks.length === 0 ? (
          <p style={{ color: 'var(--sf-fg-4)', fontSize: 12.5 }}>
            This request didn&apos;t spawn any subagents via Task.
          </p>
        ) : (
          <table style={tableStyle()}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--sf-fg-3)' }}>
                <Th>Agent</Th>
                <Th>Description</Th>
                <Th>Status</Th>
                <Th align="right">Cost</Th>
                <Th align="right">Turns</Th>
                <Th>Duration</Th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const taskDuration =
                  task.completedAt && task.startedAt
                    ? task.completedAt.getTime() - task.startedAt.getTime()
                    : null;
                return (
                  <tr
                    key={task.id}
                    style={{ borderTop: '1px solid var(--sf-border-1)' }}
                  >
                    <Td>
                      {task.displayName ?? task.agentType ?? (
                        <code>{task.memberId?.slice(0, 8)}</code>
                      )}
                      {task.parentTaskId && (
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: 10,
                            color: 'var(--sf-fg-4)',
                          }}
                        >
                          (nested)
                        </span>
                      )}
                    </Td>
                    <Td>{task.description}</Td>
                    <Td>{task.status}</Td>
                    <Td align="right">
                      {task.costUsd != null
                        ? `$${Number(task.costUsd).toFixed(4)}`
                        : '—'}
                    </Td>
                    <Td align="right">{task.turns ?? '—'}</Td>
                    <Td>
                      {taskDuration !== null
                        ? formatDuration(taskDuration)
                        : '—'}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section style={sectionStyle()}>
        <h2 style={headingStyle()}>
          Conversation ({activity.length}
          {activity.length === 500 ? '+' : ''})
        </h2>
        <p
          style={{
            fontSize: 11,
            color: 'var(--sf-fg-4)',
            marginTop: -8,
            marginBottom: 14,
          }}
        >
          User ↔ agent turns expanded. Tool calls, thinking, and system events
          collapsed by default — click any row to expand.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {activity.map((msg) => {
            const fromLabel = msg.fromMemberId
              ? memberById.get(msg.fromMemberId)?.displayName ??
                msg.fromMemberId.slice(0, 8)
              : 'user';
            const toLabel = msg.toMemberId
              ? memberById.get(msg.toMemberId)?.displayName ??
                msg.toMemberId.slice(0, 8)
              : null;
            const category = categorizeMessage(msg.type, msg.messageType);
            const time = msg.createdAt.toISOString().slice(11, 19);

            if (category === 'conversation') {
              return (
                <ConversationBubble
                  key={msg.id}
                  fromLabel={fromLabel}
                  toLabel={toLabel}
                  type={msg.type}
                  messageType={msg.messageType}
                  content={msg.content}
                  metadata={msg.metadata}
                  time={time}
                />
              );
            }
            return (
              <FoldedRow
                key={msg.id}
                category={category}
                fromLabel={fromLabel}
                toLabel={toLabel}
                type={msg.type}
                messageType={msg.messageType}
                content={msg.content}
                metadata={msg.metadata}
                summary={msg.summary}
                time={time}
              />
            );
          })}
          {activity.length === 0 && (
            <p style={{ color: 'var(--sf-fg-4)', fontSize: 12.5 }}>
              No messages recorded for this request.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status heuristic — same shape as the list page; duplicated locally to
// keep the two pages independently editable.
// ---------------------------------------------------------------------------

type DerivedStatus = 'pending' | 'running' | 'completed' | 'failed';

const RUNNING_INACTIVITY_MS = 60_000;

interface DeriveStatusInput {
  startedAt: Date;
  lastActivityAt: Date | null;
  totalTurns: number;
  errorCount: number;
}

function deriveStatus(input: DeriveStatusInput): DerivedStatus {
  if (input.errorCount > 0) return 'failed';
  const last = input.lastActivityAt;
  if (
    input.totalTurns === 0 &&
    (!last || last.getTime() === input.startedAt.getTime())
  ) {
    return 'pending';
  }
  if (last && Date.now() - last.getTime() < RUNNING_INACTIVITY_MS) {
    return 'running';
  }
  return 'completed';
}

// ---------------------------------------------------------------------------
// Message categorization + render helpers (preserved from the original
// admin detail page so the user's "team-runs polish" treatment carries
// forward — see commit 02be710's diff).
// ---------------------------------------------------------------------------

type Category = 'conversation' | 'tool' | 'thinking' | 'system';

function categorizeMessage(type: string, messageType: string): Category {
  // task_notification rows use type='user_prompt' but represent a worker's
  // synthesized result — still "conversation" semantically (it lands as a
  // user-role turn in the lead's transcript).
  if (messageType === 'task_notification') return 'conversation';
  if (messageType === 'shutdown_request' || messageType === 'shutdown_response')
    return 'system';
  if (messageType === 'broadcast') return 'conversation';
  if (messageType === 'plan_approval_response') return 'system';

  if (type === 'user_prompt' || type === 'agent_text') return 'conversation';
  if (type === 'tool_call' || type === 'tool_result') return 'tool';
  if (type === 'thinking') return 'thinking';
  return 'system';
}

interface BubbleProps {
  fromLabel: string;
  toLabel: string | null;
  type: string;
  messageType: string;
  content: string | null;
  metadata: unknown;
  time: string;
}

function ConversationBubble({
  fromLabel,
  toLabel,
  type,
  messageType,
  content,
  metadata,
  time,
}: BubbleProps) {
  // Visual: user input on left with subtle bg; agent response with accent stripe.
  const isAgent = type === 'agent_text';
  return (
    <div
      style={{
        padding: '12px 14px',
        background: 'var(--sf-bg-secondary)',
        borderRadius: 8,
        borderLeft: `3px solid ${isAgent ? 'var(--sf-accent, #4a90e2)' : 'var(--sf-fg-4)'}`,
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 8,
          marginBottom: 6,
          fontSize: 11,
          color: 'var(--sf-fg-4)',
          alignItems: 'center',
        }}
      >
        <strong style={{ color: 'var(--sf-fg-2)', fontWeight: 600 }}>
          {fromLabel}
        </strong>
        {toLabel ? <span>→ {toLabel}</span> : null}
        <span>·</span>
        <span>{time}</span>
        <span>·</span>
        <span style={{ fontFamily: 'var(--sf-font-mono, monospace)' }}>
          {messageType !== 'message' ? messageType : type}
        </span>
      </div>
      {content ? (
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            fontFamily: 'inherit',
            margin: 0,
            color: 'var(--sf-fg-1)',
            lineHeight: 1.55,
            wordBreak: 'break-word',
          }}
        >
          {content}
        </pre>
      ) : (
        <span style={{ color: 'var(--sf-fg-4)', fontSize: 12 }}>
          (no content)
        </span>
      )}
      {metadata != null && hasInterestingMetadata(metadata) ? (
        <details style={{ marginTop: 8 }}>
          <summary
            style={{
              cursor: 'pointer',
              fontSize: 11,
              color: 'var(--sf-fg-3)',
            }}
          >
            metadata
          </summary>
          <pre
            style={{
              marginTop: 4,
              fontSize: 11.5,
              background: 'var(--sf-bg-primary)',
              padding: 8,
              borderRadius: 4,
              overflow: 'auto',
            }}
          >
            {JSON.stringify(metadata, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

interface FoldedRowProps extends BubbleProps {
  category: Exclude<Category, 'conversation'>;
  summary: string | null;
}

function FoldedRow({
  category,
  fromLabel,
  toLabel,
  type,
  messageType,
  content,
  metadata,
  summary,
  time,
}: FoldedRowProps) {
  const meta = metadata as { tool_name?: string; tool_input?: unknown } | null;
  // Inline summary pulled from the most useful field per category.
  let inlineSummary: string;
  if (category === 'tool') {
    const toolName = meta?.tool_name ?? '?';
    inlineSummary =
      type === 'tool_call' ? `→ ${toolName}` : `← ${toolName}`;
  } else if (category === 'thinking') {
    inlineSummary =
      (content ?? '').slice(0, 80) +
      ((content?.length ?? 0) > 80 ? '…' : '');
  } else {
    inlineSummary = summary ?? content?.slice(0, 80) ?? messageType;
  }

  const accentColor =
    category === 'tool'
      ? 'var(--sf-fg-4)'
      : category === 'thinking'
        ? 'var(--sf-fg-4)'
        : 'var(--sf-fg-3)';

  return (
    <details
      style={{
        background: 'var(--sf-bg-primary)',
        border: '1px solid var(--sf-border-1)',
        borderRadius: 6,
        padding: '6px 10px',
        fontSize: 12,
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          listStyle: 'none',
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          color: accentColor,
          fontFamily: 'var(--sf-font-mono, monospace)',
        }}
      >
        <span style={{ fontSize: 10, opacity: 0.6 }}>{time}</span>
        <span
          style={{
            fontSize: 10,
            padding: '1px 6px',
            background: 'var(--sf-bg-secondary)',
            borderRadius: 3,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          {category}
        </span>
        <span style={{ flex: 1, color: 'var(--sf-fg-2)' }}>
          {fromLabel}
          {toLabel ? ` → ${toLabel}` : ''}
        </span>
        <span style={{ color: 'var(--sf-fg-2)' }}>{inlineSummary}</span>
      </summary>
      <div
        style={{
          marginTop: 8,
          paddingTop: 8,
          borderTop: '1px solid var(--sf-border-1)',
          fontFamily: 'var(--sf-font-mono, monospace)',
          fontSize: 11.5,
        }}
      >
        <div style={{ color: 'var(--sf-fg-4)', marginBottom: 4 }}>
          type=<code>{type}</code> messageType=<code>{messageType}</code>
        </div>
        {content ? (
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              fontFamily: 'inherit',
              margin: 0,
              color: 'var(--sf-fg-2)',
            }}
          >
            {content}
          </pre>
        ) : null}
        {metadata != null ? (
          <pre
            style={{
              marginTop: 6,
              fontSize: 11,
              background: 'var(--sf-bg-secondary)',
              padding: 8,
              borderRadius: 4,
              overflow: 'auto',
              color: 'var(--sf-fg-2)',
            }}
          >
            {JSON.stringify(metadata, null, 2)}
          </pre>
        ) : null}
      </div>
    </details>
  );
}

function hasInterestingMetadata(meta: unknown): boolean {
  if (meta == null) return false;
  if (typeof meta !== 'object') return false;
  const keys = Object.keys(meta as Record<string, unknown>);
  // Hide trigger-only metadata (purely routing info, not useful for reading).
  if (keys.length === 1 && keys[0] === 'trigger') return false;
  return keys.length > 0;
}

interface KeyValueProps {
  k: string;
  v: React.ReactNode;
}

function KeyValue({ k, v }: KeyValueProps) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '4px 0' }}>
      <dt
        style={{
          color: 'var(--sf-fg-3)',
          fontSize: 11.5,
          minWidth: 110,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        {k}
      </dt>
      <dd
        style={{
          margin: 0,
          color: 'var(--sf-fg-1)',
          fontSize: 12.5,
        }}
      >
        {v}
      </dd>
    </div>
  );
}

function sectionStyle(): React.CSSProperties {
  return {
    marginBottom: 28,
    paddingBottom: 20,
  };
}

function headingStyle(): React.CSSProperties {
  return {
    fontSize: 14,
    fontWeight: 500,
    letterSpacing: '-0.16px',
    marginBottom: 12,
    color: 'var(--sf-fg-1)',
  };
}

function dlStyle(): React.CSSProperties {
  return {
    margin: 0,
  };
}

function tableStyle(): React.CSSProperties {
  return {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 13,
  };
}

interface ThProps {
  children: React.ReactNode;
  align?: 'left' | 'right';
}

function Th({ children, align = 'left' }: ThProps) {
  return (
    <th
      style={{
        padding: '8px',
        fontWeight: 500,
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        textAlign: align,
      }}
    >
      {children}
    </th>
  );
}

interface TdProps {
  children: React.ReactNode;
  align?: 'left' | 'right';
}

function Td({ children, align = 'left' }: TdProps) {
  return (
    <td
      style={{
        padding: '8px',
        textAlign: align,
        color: 'var(--sf-fg-2)',
      }}
    >
      {children}
    </td>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}
