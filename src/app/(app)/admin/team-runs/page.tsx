import Link from 'next/link';
import {
  desc,
  and,
  eq,
  gte,
  isNull,
  isNotNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db } from '@/lib/db';
import { teamMessages, teams, users } from '@/lib/db/schema';

/**
 * /admin/team-runs — Phase G rewrite (per-request view).
 *
 * Each row is a single "request" — a `team_messages` row representing a
 * founder/external-origin user_prompt sent to the team's lead. All
 * subsequent activity (agent_text / tool_call / tool_result / etc.) is
 * grouped by `runId = user_prompt.id`. The legacy `team_runs` table was
 * dropped in migration 0016_drop_team_runs (Phase G cleanup); see
 * docs/superpowers/plans/2026-05-03-drop-team-runs-c2.md for the full
 * migration story.
 *
 * URL stays at /admin/team-runs for stability — bookmarks survive.
 *
 * Auth gated by src/app/(app)/admin/layout.tsx (ADMIN_EMAILS env var).
 *
 * Query params:
 *   ?teamId=<id>      — filter by team
 *   ?sinceDays=<n>    — restrict to the last N days (default 7). The
 *                       default exists because rows written before
 *                       commit 5ca8887 carry NULL runId and show up as
 *                       orphan singletons. 7 days is comfortably after
 *                       Phase G shipped.
 *
 * Dropped vs the team_runs era (no per-row equivalent post-Phase-E):
 *   - status filter (`?status=`)  → status is now derived per-row
 *   - cost filter   (`?minCost=`) → no per-message cost; will return
 *                                   when team-budget moves to
 *                                   agent_runs.totalTokens-based tracking
 *   - trigger col / filter         → no per-request trigger column;
 *                                   the user_prompt content carries the
 *                                   intent inline
 */
export default async function AdminTeamRunsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const teamIdFilter =
    typeof params.teamId === 'string' ? params.teamId : null;
  const sinceDaysRaw =
    typeof params.sinceDays === 'string' ? Number(params.sinceDays) : null;
  // Default to 7 days. The default is what hides pre-5ca8887 rows whose
  // runId is NULL — see file-header comment.
  const sinceDays =
    sinceDaysRaw && Number.isFinite(sinceDaysRaw) && sinceDaysRaw > 0
      ? sinceDaysRaw
      : 7;
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  // The "request" filter: a user_prompt with messageType='message',
  // originating from outside the team (fromMemberId IS NULL — the founder
  // / external sender), targeting a specific agent (toAgentId IS NOT NULL,
  // typically the lead). task_notification rows ALSO carry type='user_prompt'
  // but are messageType='task_notification' (excluded by the eq below).
  const filters: SQL[] = [
    eq(teamMessages.type, 'user_prompt'),
    eq(teamMessages.messageType, 'message'),
    isNull(teamMessages.fromMemberId),
    isNotNull(teamMessages.toAgentId),
    gte(teamMessages.createdAt, since),
  ];
  if (teamIdFilter) filters.push(eq(teamMessages.teamId, teamIdFilter));

  // Subquery aggregates. The correlation column is the user_prompt's id
  // — every downstream row carries it on `runId` (post-5ca8887).
  // `lastActivityAt` is the max(created_at) of activity rows.
  //
  // Note on raw column references: we use literal SQL ("act"."created_at")
  // for the inner subquery columns instead of `${teamMessages.createdAt}`
  // because drizzle interpolates the column reference relative to the
  // FROM table (team_messages), not the inner alias. That would generate
  // `max("team_messages"."created_at")` referring to the OUTER table —
  // Postgres rejects that as "column must appear in GROUP BY". The outer
  // correlation `act.run_id = "team_messages"."id"` IS what we want
  // referencing the outer row, so we keep that one as a drizzle column ref.
  const lastActivityAt = sql<Date | null>`(
    SELECT max("act"."created_at") FROM ${teamMessages} AS "act"
    WHERE "act"."run_id" = ${teamMessages.id}
  )`;
  const totalTurns = sql<number>`(
    SELECT count(*)::int FROM ${teamMessages} AS "act"
    WHERE "act"."run_id" = ${teamMessages.id}
      AND "act"."type" = 'agent_text'
  )`;
  const errorCount = sql<number>`(
    SELECT count(*)::int FROM ${teamMessages} AS "act"
    WHERE "act"."run_id" = ${teamMessages.id}
      AND "act"."type" = 'tool_result'
      AND ("act"."metadata"->>'is_error')::boolean = true
  )`;

  const rows = await db
    .select({
      requestId: teamMessages.id,
      teamId: teamMessages.teamId,
      teamName: teams.name,
      ownerEmail: users.email,
      goal: teamMessages.content,
      startedAt: teamMessages.createdAt,
      lastActivityAt,
      totalTurns,
      errorCount,
    })
    .from(teamMessages)
    .leftJoin(teams, eq(teams.id, teamMessages.teamId))
    .leftJoin(users, eq(users.id, teams.userId))
    .where(and(...filters))
    .orderBy(desc(teamMessages.createdAt))
    .limit(100);

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h1
          style={{
            fontSize: 18,
            fontWeight: 500,
            letterSpacing: '-0.18px',
            margin: 0,
          }}
        >
          Recent requests
        </h1>
        <p
          style={{
            fontSize: 11.5,
            color: 'var(--sf-fg-4)',
            marginTop: 4,
            letterSpacing: '-0.1px',
          }}
        >
          One row per founder→lead user_prompt. Activity (agent_text /
          tool_call / tool_result) groups by <code>runId =
          user_prompt.id</code>.
        </p>
      </div>

      <FilterBar teamIdFilter={teamIdFilter} sinceDays={sinceDays} />

      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 13,
        }}
      >
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--sf-fg-3)' }}>
            <Th>Team</Th>
            <Th>Goal</Th>
            <Th>Status</Th>
            <Th>Started</Th>
            <Th>Duration</Th>
            <Th align="right">Turns</Th>
            <Th align="right">Trace</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const status = deriveStatus({
              startedAt: row.startedAt,
              lastActivityAt: row.lastActivityAt,
              totalTurns: row.totalTurns,
              errorCount: row.errorCount,
            });
            const durationMs =
              row.lastActivityAt && row.startedAt
                ? new Date(row.lastActivityAt).getTime() -
                  row.startedAt.getTime()
                : null;
            const goalPreview =
              row.goal && row.goal.length > 120
                ? `${row.goal.slice(0, 120).trim()}…`
                : (row.goal ?? '—');
            return (
              <tr
                key={row.requestId}
                style={{
                  borderTop: '1px solid var(--sf-border-1)',
                }}
              >
                <Td>
                  <Link
                    href={`/admin/team-runs/${row.requestId}`}
                    style={{
                      color: 'var(--sf-link)',
                      textDecoration: 'none',
                    }}
                  >
                    {row.teamName ?? row.teamId.slice(0, 8)}
                  </Link>
                  {row.ownerEmail ? (
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--sf-fg-4)',
                        marginTop: 2,
                      }}
                    >
                      {row.ownerEmail}
                    </div>
                  ) : null}
                </Td>
                <Td>
                  <span
                    style={{
                      color: 'var(--sf-fg-2)',
                      fontSize: 12.5,
                      lineHeight: 1.4,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                    title={row.goal ?? undefined}
                  >
                    {goalPreview}
                  </span>
                </Td>
                <Td>
                  <StatusPill status={status} />
                </Td>
                <Td>{row.startedAt ? formatTime(row.startedAt) : '—'}</Td>
                <Td>{durationMs !== null ? formatDuration(durationMs) : '—'}</Td>
                <Td align="right">{row.totalTurns ?? 0}</Td>
                <Td align="right">
                  <Link
                    href={`/admin/team-runs/${row.requestId}`}
                    style={{
                      color: 'var(--sf-link)',
                      textDecoration: 'none',
                      fontSize: 12,
                      fontFamily: 'var(--sf-font-mono, monospace)',
                    }}
                  >
                    {row.requestId.slice(0, 8)} →
                  </Link>
                </Td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={7}
                style={{
                  padding: 24,
                  textAlign: 'center',
                  color: 'var(--sf-fg-4)',
                }}
              >
                No requests in the last {sinceDays} day
                {sinceDays === 1 ? '' : 's'}.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <p
        style={{
          fontSize: 11,
          color: 'var(--sf-fg-4)',
          marginTop: 12,
          letterSpacing: '-0.12px',
        }}
      >
        Showing up to 100 most recent rows in the last {sinceDays} day
        {sinceDays === 1 ? '' : 's'}. Cost / trigger columns retired with
        the dropped <code>team_runs</code> table — see migration{' '}
        <code>0016_drop_team_runs</code>.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status heuristic (v1 — derived from team_messages, not a column)
// ---------------------------------------------------------------------------

type DerivedStatus = 'pending' | 'running' | 'completed' | 'failed';

const RUNNING_INACTIVITY_MS = 60_000;

interface DeriveStatusInput {
  startedAt: Date;
  lastActivityAt: Date | string | null;
  totalTurns: number;
  errorCount: number;
}

function deriveStatus(input: DeriveStatusInput): DerivedStatus {
  if (input.errorCount > 0) return 'failed';

  const last = input.lastActivityAt
    ? new Date(input.lastActivityAt)
    : null;
  // No activity at all → still pending. (The user_prompt itself shares
  // the runId in the subquery so an empty activity row count means the
  // worker hasn't even started writing rows. Realistically this is a
  // sub-second window because wake() is fast, but the state exists.)
  if (input.totalTurns === 0 && (!last || last.getTime() === input.startedAt.getTime())) {
    return 'pending';
  }
  // Last activity within the inactivity window → still actively running.
  if (last && Date.now() - last.getTime() < RUNNING_INACTIVITY_MS) {
    return 'running';
  }
  // Otherwise: we've seen activity AND it's been quiet for a while.
  // Treat as completed. Real terminal-event detection (e.g. an
  // agent_runs.status='completed' join) is a v2 follow-up; this
  // heuristic gets the common cases right.
  return 'completed';
}

// ---------------------------------------------------------------------------
// Presentation primitives
// ---------------------------------------------------------------------------

interface ThProps {
  children: React.ReactNode;
  align?: 'left' | 'right';
}

function Th({ children, align = 'left' }: ThProps) {
  return (
    <th
      style={{
        padding: '10px 8px',
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
        padding: '10px 8px',
        textAlign: align,
        color: 'var(--sf-fg-2)',
        verticalAlign: 'top',
      }}
    >
      {children}
    </td>
  );
}

interface StatusPillProps {
  status: DerivedStatus;
}

function StatusPill({ status }: StatusPillProps) {
  const color =
    status === 'completed'
      ? 'var(--sf-success)'
      : status === 'running'
        ? 'var(--sf-accent)'
        : status === 'failed'
          ? 'var(--sf-error-ink)'
          : 'var(--sf-fg-4)';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11.5,
        letterSpacing: '-0.12px',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
        }}
      />
      {status}
    </span>
  );
}

function formatTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\..+$/, ' UTC');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

interface FilterBarProps {
  teamIdFilter: string | null;
  sinceDays: number;
}

function FilterBar({ teamIdFilter, sinceDays }: FilterBarProps) {
  // GET form so filters survive a reload + are shareable URLs.
  return (
    <form
      method="GET"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'flex-end',
        marginBottom: 18,
      }}
    >
      <FilterField label="Team ID">
        <input
          name="teamId"
          type="text"
          defaultValue={teamIdFilter ?? ''}
          style={filterStyle()}
          placeholder="uuid"
        />
      </FilterField>
      <FilterField label="Since (days)">
        <input
          name="sinceDays"
          type="number"
          min="1"
          defaultValue={sinceDays}
          style={filterStyle()}
        />
      </FilterField>
      <button
        type="submit"
        style={{
          height: 30,
          padding: '0 14px',
          border: '1px solid var(--sf-fg-1)',
          borderRadius: 6,
          background: 'var(--sf-fg-1)',
          color: 'var(--sf-bg-1)',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        Apply
      </button>
    </form>
  );
}

interface FilterFieldProps {
  label: string;
  children: React.ReactNode;
}

function FilterField({ label, children }: FilterFieldProps) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        style={{
          fontSize: 10.5,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: 'var(--sf-fg-3)',
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function filterStyle(): React.CSSProperties {
  return {
    height: 30,
    padding: '0 8px',
    border: '1px solid var(--sf-border-1)',
    borderRadius: 6,
    background: 'var(--sf-bg-primary)',
    fontSize: 12,
    color: 'var(--sf-fg-1)',
    minWidth: 120,
  };
}
