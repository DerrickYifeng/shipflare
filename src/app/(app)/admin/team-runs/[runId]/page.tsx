import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, asc } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  teamRuns,
  teams,
  teamMembers,
  teamMessages,
  teamTasks,
} from '@/lib/db/schema';

/**
 * /admin/team-runs/[runId] — single-run trace view. Auth is gated by
 * src/app/(app)/admin/layout.tsx (ADMIN_EMAILS).
 *
 * Shows:
 *   - run header (team, trigger, status, cost, turns, duration, traceId)
 *   - team_tasks breakdown (per-member cost from each subagent spawn)
 *   - team_messages timeline (chronological, tool_call/tool_result pairs)
 */
export default async function AdminTeamRunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;

  const [run] = await db
    .select({
      id: teamRuns.id,
      teamId: teamRuns.teamId,
      teamName: teams.name,
      trigger: teamRuns.trigger,
      goal: teamRuns.goal,
      status: teamRuns.status,
      startedAt: teamRuns.startedAt,
      completedAt: teamRuns.completedAt,
      totalCostUsd: teamRuns.totalCostUsd,
      totalTurns: teamRuns.totalTurns,
      traceId: teamRuns.traceId,
      errorMessage: teamRuns.errorMessage,
    })
    .from(teamRuns)
    .leftJoin(teams, eq(teams.id, teamRuns.teamId))
    .where(eq(teamRuns.id, runId))
    .limit(1);

  if (!run) notFound();

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

  const messages = await db
    .select({
      id: teamMessages.id,
      fromMemberId: teamMessages.fromMemberId,
      toMemberId: teamMessages.toMemberId,
      type: teamMessages.type,
      content: teamMessages.content,
      metadata: teamMessages.metadata,
      createdAt: teamMessages.createdAt,
    })
    .from(teamMessages)
    .where(eq(teamMessages.runId, runId))
    .orderBy(asc(teamMessages.createdAt))
    .limit(500);

  const memberById = new Map<string, { agentType: string; displayName: string }>();
  for (const task of tasks) {
    if (task.memberId && task.agentType && task.displayName) {
      memberById.set(task.memberId, {
        agentType: task.agentType,
        displayName: task.displayName,
      });
    }
  }

  const durationMs =
    run.completedAt && run.startedAt
      ? run.completedAt.getTime() - run.startedAt.getTime()
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
        <h2 style={headingStyle()}>Run</h2>
        <dl style={dlStyle()}>
          <KeyValue k="Run ID" v={<code>{run.id}</code>} />
          <KeyValue
            k="Team"
            v={run.teamName ?? <code>{run.teamId}</code>}
          />
          <KeyValue k="Trigger" v={run.trigger} />
          <KeyValue k="Status" v={run.status} />
          <KeyValue
            k="Started"
            v={run.startedAt ? run.startedAt.toISOString() : '—'}
          />
          <KeyValue
            k="Completed"
            v={run.completedAt ? run.completedAt.toISOString() : '—'}
          />
          <KeyValue
            k="Duration"
            v={durationMs !== null ? formatDuration(durationMs) : '—'}
          />
          <KeyValue
            k="Total cost"
            v={
              run.totalCostUsd != null
                ? `$${Number(run.totalCostUsd).toFixed(4)}`
                : '—'
            }
          />
          <KeyValue k="Total turns" v={run.totalTurns ?? '—'} />
          <KeyValue
            k="Trace ID"
            v={run.traceId ? <code>{run.traceId}</code> : '—'}
          />
        </dl>
        {run.goal && (
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
            {run.goal}
          </div>
        )}
        {run.errorMessage && (
          <div
            style={{
              marginTop: 12,
              padding: '10px 12px',
              background: 'var(--sf-error-light)',
              color: 'var(--sf-error-ink)',
              borderRadius: 6,
              fontSize: 12.5,
            }}
          >
            <strong>Error:</strong> {run.errorMessage}
          </div>
        )}
      </section>

      <section style={sectionStyle()}>
        <h2 style={headingStyle()}>Spawned tasks ({tasks.length})</h2>
        {tasks.length === 0 ? (
          <p style={{ color: 'var(--sf-fg-4)', fontSize: 12.5 }}>
            This run didn&apos;t spawn any subagents via Task.
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
          Messages ({messages.length}
          {messages.length === 500 ? '+' : ''})
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.map((msg) => {
            const fromLabel = msg.fromMemberId
              ? memberById.get(msg.fromMemberId)?.displayName ??
                msg.fromMemberId.slice(0, 8)
              : 'user';
            const toLabel = msg.toMemberId
              ? memberById.get(msg.toMemberId)?.displayName ??
                msg.toMemberId.slice(0, 8)
              : null;
            return (
              <div
                key={msg.id}
                style={{
                  padding: '10px 12px',
                  background: 'var(--sf-bg-secondary)',
                  borderRadius: 6,
                  fontSize: 12.5,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    marginBottom: 6,
                    fontSize: 11,
                    color: 'var(--sf-fg-4)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                  }}
                >
                  <span>{msg.createdAt.toISOString()}</span>
                  <span>· {msg.type}</span>
                  <span>
                    · {fromLabel}
                    {toLabel ? ` → ${toLabel}` : ''}
                  </span>
                </div>
                {msg.content && (
                  <pre
                    style={{
                      whiteSpace: 'pre-wrap',
                      fontFamily: 'inherit',
                      margin: 0,
                      color: 'var(--sf-fg-2)',
                    }}
                  >
                    {msg.content}
                  </pre>
                )}
                {msg.metadata != null && (
                  <details style={{ marginTop: 6 }}>
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
                      {JSON.stringify(msg.metadata, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            );
          })}
          {messages.length === 0 && (
            <p style={{ color: 'var(--sf-fg-4)', fontSize: 12.5 }}>
              No messages recorded for this run.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function KeyValue({ k, v }: { k: string; v: React.ReactNode }) {
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

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
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

function Td({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
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
