/**
 * One-shot Phase E migration: ensure every team has a lead `agent_runs` row.
 *
 * Pre-Phase E, the team lead was driven implicitly by team-run.ts and never
 * had its own `agent_runs` row. Phase E unifies the lead as just another
 * agent_runs row (agentDefName='coordinator', status='sleeping' until woken).
 *
 * This script iterates every team and calls `ensureLeadAgentRun`, which is
 * idempotent — safe to run multiple times. Teams that already have a lead
 * row are returned as-is; teams without one get a new sleeping row inserted.
 *
 * Run:
 *   pnpm tsx scripts/backfill-lead-agent-runs.ts
 *
 * Verify:
 *   psql $POSTGRES_URL -c "SELECT count(*), agent_def_name FROM agent_runs \
 *     WHERE agent_def_name = 'coordinator' GROUP BY agent_def_name"
 *
 * Requires DATABASE_URL in env.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { teams } from '@/lib/db/schema';
import { ensureLeadAgentRun } from '@/lib/team/spawn-lead';

interface BackfillSummary {
  scanned: number;
  ensured: number;
  failed: number;
  failures: Array<{ teamId: string; error: string }>;
}

async function main() {
  const summary: BackfillSummary = {
    scanned: 0,
    ensured: 0,
    failed: 0,
    failures: [],
  };

  const allTeams = await db.select({ id: teams.id }).from(teams);
  console.log(
    `[backfill-lead-agent-runs] scanning ${allTeams.length} team(s)...`,
  );

  for (const team of allTeams) {
    summary.scanned += 1;
    try {
      const { agentId } = await ensureLeadAgentRun(team.id, db);
      summary.ensured += 1;
      console.log(`  team ${team.id} -> lead ${agentId}`);
    } catch (err) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      summary.failures.push({ teamId: team.id, error: message });
      console.error(`  team ${team.id} FAILED: ${message}`);
    }
  }

  console.log('---');
  console.log(`[backfill-lead-agent-runs] summary:`);
  console.log(`  scanned : ${summary.scanned}`);
  console.log(`  ensured : ${summary.ensured}`);
  console.log(`  failed  : ${summary.failed}`);
  if (summary.failures.length > 0) {
    console.log('  failures:');
    for (const f of summary.failures) {
      console.log(`    - ${f.teamId}: ${f.error}`);
    }
  }

  // Force-close open DB connections so the process exits cleanly.
  await db.execute(sql`SELECT 1`);
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[backfill-lead-agent-runs] unhandled error:', err);
  process.exit(2);
});
