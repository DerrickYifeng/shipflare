import Link from 'next/link';
import { desc, and, eq, gte, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db';
import { teamRuns, teams } from '@/lib/db/schema';

/**
 * /admin/team-runs — read-only list of recent team_runs across all teams.
 * Auth is gated by src/app/(app)/admin/layout.tsx (ADMIN_EMAILS env var).
 *
 * Query params:
 *   ?status=running|completed|failed  — filter by status
 *   ?teamId=<id>                      — filter by team
 *   ?minCost=0.50                     — only runs with cost >= threshold
 *   ?sinceDays=7                      — only runs in the last N days
 */
export default async function AdminTeamRunsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = typeof params.status === 'string' ? params.status : null;
  const teamIdFilter = typeof params.teamId === 'string' ? params.teamId : null;
  const minCost =
    typeof params.minCost === 'string' ? Number(params.minCost) : null;
  const sinceDays =
    typeof params.sinceDays === 'string' ? Number(params.sinceDays) : null;

  const filters: SQL[] = [];
  if (status) filters.push(eq(teamRuns.status, status));
  if (teamIdFilter) filters.push(eq(teamRuns.teamId, teamIdFilter));
  if (sinceDays && sinceDays > 0 && Number.isFinite(sinceDays)) {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    filters.push(gte(teamRuns.startedAt, since));
  }
  if (minCost && Number.isFinite(minCost) && minCost > 0) {
    filters.push(sql`${teamRuns.totalCostUsd} >= ${String(minCost)}`);
  }

  const where = filters.length > 0 ? and(...filters) : undefined;

  const rows = await db
    .select({
      id: teamRuns.id,
      teamId: teamRuns.teamId,
      teamName: teams.name,
      trigger: teamRuns.trigger,
      status: teamRuns.status,
      startedAt: teamRuns.startedAt,
      completedAt: teamRuns.completedAt,
      totalCostUsd: teamRuns.totalCostUsd,
      totalTurns: teamRuns.totalTurns,
      traceId: teamRuns.traceId,
    })
    .from(teamRuns)
    .leftJoin(teams, eq(teams.id, teamRuns.teamId))
    .where(where)
    .orderBy(desc(teamRuns.startedAt))
    .limit(100);

  return (
    <div>
      <FilterBar
        status={status}
        teamIdFilter={teamIdFilter}
        minCost={minCost}
        sinceDays={sinceDays}
      />

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
            <Th>Trigger</Th>
            <Th>Status</Th>
            <Th>Started</Th>
            <Th>Duration</Th>
            <Th align="right">Cost</Th>
            <Th align="right">Turns</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const durationMs =
              row.completedAt && row.startedAt
                ? row.completedAt.getTime() - row.startedAt.getTime()
                : null;
            return (
              <tr
                key={row.id}
                style={{
                  borderTop: '1px solid var(--sf-border-1)',
                }}
              >
                <Td>
                  <Link
                    href={`/admin/team-runs/${row.id}`}
                    style={{
                      color: 'var(--sf-link)',
                      textDecoration: 'none',
                    }}
                  >
                    {row.teamName ?? row.teamId.slice(0, 8)}
                  </Link>
                </Td>
                <Td>{row.trigger}</Td>
                <Td>
                  <StatusPill status={row.status} />
                </Td>
                <Td>{row.startedAt ? formatTime(row.startedAt) : '—'}</Td>
                <Td>{durationMs !== null ? formatDuration(durationMs) : '—'}</Td>
                <Td align="right">
                  {row.totalCostUsd != null
                    ? `$${Number(row.totalCostUsd).toFixed(4)}`
                    : '—'}
                </Td>
                <Td align="right">{row.totalTurns ?? '—'}</Td>
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
                No team_runs match these filters.
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
        Showing up to 100 most recent rows. Filters compose — add
        <code
          style={{ padding: '0 4px', background: 'var(--sf-bg-secondary)' }}
        >
          ?status=failed&sinceDays=3
        </code>{' '}
        to narrow.
      </p>
    </div>
  );
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
        padding: '10px 8px',
        textAlign: align,
        color: 'var(--sf-fg-2)',
      }}
    >
      {children}
    </td>
  );
}

function StatusPill({ status }: { status: string }) {
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

function FilterBar({
  status,
  teamIdFilter,
  minCost,
  sinceDays,
}: {
  status: string | null;
  teamIdFilter: string | null;
  minCost: number | null;
  sinceDays: number | null;
}) {
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
      <FilterField label="Status">
        <select
          name="status"
          defaultValue={status ?? ''}
          style={filterStyle()}
        >
          <option value="">any</option>
          <option value="running">running</option>
          <option value="completed">completed</option>
          <option value="failed">failed</option>
          <option value="cancelled">cancelled</option>
          <option value="pending">pending</option>
        </select>
      </FilterField>
      <FilterField label="Team ID">
        <input
          name="teamId"
          type="text"
          defaultValue={teamIdFilter ?? ''}
          style={filterStyle()}
          placeholder="uuid"
        />
      </FilterField>
      <FilterField label="Min cost (USD)">
        <input
          name="minCost"
          type="number"
          step="0.01"
          min="0"
          defaultValue={minCost ?? ''}
          style={filterStyle()}
        />
      </FilterField>
      <FilterField label="Since (days)">
        <input
          name="sinceDays"
          type="number"
          min="1"
          defaultValue={sinceDays ?? ''}
          style={filterStyle()}
          placeholder="7"
        />
      </FilterField>
      <button
        type="submit"
        style={{
          height: 30,
          padding: '0 14px',
          border: '1px solid var(--sf-border-1)',
          borderRadius: 6,
          background: 'var(--sf-bg-primary)',
          cursor: 'pointer',
          fontSize: 12,
          color: 'var(--sf-fg-1)',
        }}
      >
        Apply
      </button>
    </form>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
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
