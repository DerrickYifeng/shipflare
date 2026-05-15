/**
 * Phase D migration backfill — one-shot, idempotent.
 *
 * Required ONCE before flipping `ENABLE_DURABLE_LEAD=true` in prod. Safe to
 * re-run; only rows still in transient statuses (`running` / `resuming` /
 * `sleeping`) are touched, and the sleeping branch is itself idempotent
 * (`next_wake_at` is only set when it's currently NULL).
 *
 * Transient-row policy:
 *   - status='running'  → mark failed; no checkpoint exists, the durable
 *     path can't resume cleanly. These rows were going to die on the next
 *     worker restart anyway. Sets `shutdown_reason` for forensics.
 *   - status='resuming' → same as running. Mark failed.
 *   - status='sleeping' → preserve. Set `next_wake_at = sleep_until` so the
 *     row is structurally consistent with what the durable Sleep handler
 *     would have written. The existing BullMQ delayed job (enqueued at
 *     sleep-time by `SleepTool`) is what actually resumes the row; the
 *     `next_wake_at` column is currently advisory metadata (no scheduler
 *     scans it yet — that's a forward-looking column documented in the
 *     schema).
 *
 * Usage:
 *   bun run scripts/backfill-agent-runs-checkpoint.ts          # dry-run preview
 *   bun run scripts/backfill-agent-runs-checkpoint.ts --commit # mutate
 *
 * Requires DATABASE_URL in env (`.env.local` in dev, prod env at deploy time).
 *
 * Exit codes:
 *   0 — success (dry-run preview or commit completed cleanly)
 *   1 — failure (DB error, unexpected throw)
 */
import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRuns } from '@/lib/db/schema';

const COMMIT_FLAG = '--commit';
const SHUTDOWN_REASON = 'migration_to_durable_lead_2026_05';

interface TransientRow {
  id: string;
  status: string;
  sleepUntil: Date | null;
  nextWakeAt: Date | null;
}

interface Plan {
  toFail: TransientRow[];
  toSetWake: TransientRow[];
  skippedSleepingAlreadySet: TransientRow[];
  skippedSleepingNoSleepUntil: TransientRow[];
}

function partition(rows: TransientRow[]): Plan {
  const toFail: TransientRow[] = [];
  const toSetWake: TransientRow[] = [];
  const skippedSleepingAlreadySet: TransientRow[] = [];
  const skippedSleepingNoSleepUntil: TransientRow[] = [];

  for (const row of rows) {
    if (row.status === 'running' || row.status === 'resuming') {
      toFail.push(row);
      continue;
    }
    if (row.status === 'sleeping') {
      if (row.nextWakeAt !== null) {
        skippedSleepingAlreadySet.push(row);
        continue;
      }
      if (row.sleepUntil === null) {
        // Defensive: a sleeping row with NULL sleep_until shouldn't exist
        // (Sleep tool always writes it), but if one does we can't compute
        // a wake target. Skip it; the operator should hand-resolve.
        skippedSleepingNoSleepUntil.push(row);
        continue;
      }
      toSetWake.push(row);
    }
  }

  return {
    toFail,
    toSetWake,
    skippedSleepingAlreadySet,
    skippedSleepingNoSleepUntil,
  };
}

function logPlan(plan: Plan, isCommit: boolean): void {
  const mode = isCommit ? 'COMMIT' : 'DRY-RUN';
  console.log(`\n=== Phase D migration backfill (${mode}) ===`);
  console.log(`To fail (running/resuming)               : ${plan.toFail.length}`);
  console.log(`To set next_wake_at (sleeping w/ null)   : ${plan.toSetWake.length}`);
  console.log(`Skipped (sleeping w/ non-null wake)      : ${plan.skippedSleepingAlreadySet.length}`);
  console.log(`Skipped (sleeping w/ NULL sleep_until)   : ${plan.skippedSleepingNoSleepUntil.length}`);

  if (plan.toFail.length > 0) {
    console.log('\nWill mark failed:');
    for (const r of plan.toFail) {
      console.log(`  ${r.id}  status=${r.status}`);
    }
  }
  if (plan.toSetWake.length > 0) {
    console.log('\nWill set next_wake_at = sleep_until:');
    for (const r of plan.toSetWake) {
      console.log(`  ${r.id}  sleep_until=${r.sleepUntil?.toISOString() ?? 'NULL'}`);
    }
  }
  if (plan.skippedSleepingNoSleepUntil.length > 0) {
    console.log('\nWARNING — sleeping rows with NULL sleep_until (manual review):');
    for (const r of plan.skippedSleepingNoSleepUntil) {
      console.log(`  ${r.id}`);
    }
  }
}

async function applyPlan(plan: Plan): Promise<void> {
  if (plan.toFail.length > 0) {
    const failedIds = plan.toFail.map((r) => r.id);
    const result = await db
      .update(agentRuns)
      .set({
        status: 'failed',
        shutdownReason: SHUTDOWN_REASON,
      })
      .where(inArray(agentRuns.id, failedIds))
      .returning({ id: agentRuns.id });
    console.log(`✓ Marked ${result.length} running/resuming rows as failed.`);
  }

  // Per-row update for sleeping rows — each carries its own sleep_until
  // value. N is small (sleeping rows in transit at deploy time, typically
  // <100); a CASE-WHEN batch would be premature optimization.
  for (const r of plan.toSetWake) {
    if (r.sleepUntil === null) continue;
    await db
      .update(agentRuns)
      .set({ nextWakeAt: r.sleepUntil })
      .where(eq(agentRuns.id, r.id));
  }
  if (plan.toSetWake.length > 0) {
    console.log(`✓ Set next_wake_at on ${plan.toSetWake.length} sleeping rows.`);
  }
}

async function main(): Promise<void> {
  const isCommit = process.argv.includes(COMMIT_FLAG);

  const transientRows = (await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      sleepUntil: agentRuns.sleepUntil,
      nextWakeAt: agentRuns.nextWakeAt,
    })
    .from(agentRuns)
    .where(inArray(agentRuns.status, ['running', 'resuming', 'sleeping']))) as TransientRow[];

  const plan = partition(transientRows);
  logPlan(plan, isCommit);

  if (!isCommit) {
    console.log('\n(DRY-RUN: pass --commit to apply)\n');
    return;
  }

  await applyPlan(plan);
  console.log('\n✓ Backfill complete.\n');
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('\n✗ Backfill failed:', message);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  });
