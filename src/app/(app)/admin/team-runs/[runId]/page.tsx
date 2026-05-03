import Link from 'next/link';

/**
 * /admin/team-runs/[runId] — TEMPORARY PLACEHOLDER pending Task 2 of
 * the 2026-05-03 drop-team-runs-c2 plan.
 *
 * Phase G cleanup (migration 0016_drop_team_runs) dropped the
 * `team_runs` table that this page used to read from. Task 2 rewires
 * this page to load the user_prompt header + activity timeline +
 * team_tasks breakdown by `runId = user_prompt.id`. Until that lands,
 * this stub keeps the route addressable so deep-linked bookmarks
 * (e.g. from logs) don't 404.
 *
 * The runId-stamped writes from `agent-run.ts` (restored in the same
 * Phase G commit) are already populating `team_messages.run_id` —
 * Task 2 just needs to query them.
 */

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ runId: string }>;
}

export default async function AdminTeamRunDetailPage({ params }: Props) {
  const { runId } = await params;

  return (
    <div style={{ padding: 24, fontSize: 13, lineHeight: 1.6 }}>
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
      <h1
        style={{
          fontSize: 18,
          fontWeight: 500,
          marginBottom: 14,
          letterSpacing: '-0.18px',
        }}
      >
        Request detail
      </h1>
      <p style={{ color: 'var(--sf-fg-3)', marginBottom: 12 }}>
        Detail view for request <code>{runId}</code> is being rewritten as
        part of the Phase G cleanup. The legacy <code>team_runs</code>{' '}
        table was dropped in migration <code>0016_drop_team_runs</code>; the
        new view loads the originating <code>user_prompt</code> header plus
        its activity timeline and <code>team_tasks</code> breakdown — see
        Task 2 of the <code>2026-05-03-drop-team-runs-c2</code> plan.
      </p>
    </div>
  );
}
