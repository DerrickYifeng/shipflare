/**
 * /admin/team-runs — TEMPORARY PLACEHOLDER pending Task 2 of the
 * 2026-05-03 drop-team-runs-c2 plan.
 *
 * Phase G cleanup (migration 0016_drop_team_runs) dropped the
 * `team_runs` table that this page used to read from. Task 2 of the
 * plan rewrites this page to aggregate `team_messages` per
 * `user_prompt` (one row per request), preserving the recently-added
 * `ownerEmail` and `Trace` columns. Until that lands, this stub keeps
 * the route addressable so admin nav and bookmarks don't 404.
 *
 * The runId-stamped writes from `agent-run.ts` (restored in the same
 * Phase G commit) are already populating `team_messages.run_id` —
 * Task 2 just needs to query them.
 */

export const dynamic = 'force-dynamic';

export default function AdminTeamRunsPage() {
  return (
    <div style={{ padding: 24, fontSize: 13, lineHeight: 1.6 }}>
      <h1
        style={{
          fontSize: 18,
          fontWeight: 500,
          marginBottom: 14,
          letterSpacing: '-0.18px',
        }}
      >
        Recent requests
      </h1>
      <p style={{ color: 'var(--sf-fg-3)', marginBottom: 12 }}>
        This admin view is being rewritten as part of the Phase G cleanup.
        The legacy <code>team_runs</code> table was dropped in migration
        <code> 0016_drop_team_runs</code>; the new view queries{' '}
        <code>team_messages</code> per <code>user_prompt</code> and lands in
        Task 2 of the <code>2026-05-03-drop-team-runs-c2</code> plan.
      </p>
      <p style={{ color: 'var(--sf-fg-4)', fontSize: 12 }}>
        runId stamping on <code>team_messages</code> is already live — Task 2
        just needs to query the new shape.
      </p>
    </div>
  );
}
