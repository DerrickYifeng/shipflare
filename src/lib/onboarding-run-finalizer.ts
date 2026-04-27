/**
 * Finalize any in-flight `trigger='onboarding'` team-run on a team so the
 * kickoff enqueue (immediately after commit) doesn't get swallowed by
 * `enqueueTeamRun`'s "one running run per team" guard.
 *
 * Background: `POST /api/onboarding/plan` enqueues an analyst run with
 * `trigger='onboarding'`. The agent's job is to call `write_strategic_path`
 * and emit StructuredOutput. Once the path is written, anything the agent
 * does afterward is wasted compute — but the run keeps `status='running'`
 * until the worker observes the StructuredOutput and flips it to
 * `'completed'`. If the user clicks Commit before that flip lands, the
 * subsequent `enqueueTeamRun({ trigger: 'kickoff', ... })` sees a running
 * row, returns `{ alreadyRunning: true }`, and the freshly-created
 * `Kickoff` conversation is never bound to a run. The user lands on
 * `/team` and sees an empty Kickoff chat with `0 drafts in flight`.
 *
 * The finalizer pre-empts that race: at commit time the strategic path is
 * persisted in the DB, so the analyst run has nothing left to contribute.
 * We mark it `cancelled` (honest about cutting it short) and signal the
 * worker to abort mid-turn so the in-flight Anthropic stream unwinds and
 * the partial unique index `idx_team_runs_one_running_per_team` clears
 * before kickoff enqueues.
 */
import { and, eq, inArray, not } from 'drizzle-orm';
import { db } from '@/lib/db';
import { teamRuns } from '@/lib/db/schema';
import { getPubSubPublisher } from '@/lib/redis';
import { teamCancelChannel } from '@/tools/SendMessageTool/SendMessageTool';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:onboarding-run-finalizer');

export interface FinalizeOnboardingRunsResult {
  /** Number of rows whose status flipped to 'cancelled'. */
  finalized: number;
  /** Run ids that were finalized — useful for logs / metrics / tests. */
  runIds: string[];
}

/**
 * Finalize every pending/running onboarding-trigger team_run for a team.
 *
 * Lanes mirror the user-cancel route (`/api/team/run/[runId]/cancel`):
 *   1. DB flip — authoritative; survives worker crashes. Conditional on
 *      the row not being terminal already so we don't race the worker's
 *      own happy-path completion.
 *   2. Cancel pub/sub — fires the worker's AbortController so the
 *      in-flight Anthropic stream unwinds; saves a few cents of tokens
 *      per cancelled run.
 *
 * No SSE broadcast lane: onboarding-trigger messages are filtered out of
 * `/team` by design (see `team/page.tsx:169, 205`), so the user never
 * sees those messages — broadcasting "Run cancelled by user" would
 * confuse anyone watching the admin panel.
 *
 * Returns the count of rows actually finalized (zero is fine and common —
 * the analyst usually finishes before the user gets through stage 5).
 */
export async function finalizePendingOnboardingRuns(
  teamId: string,
): Promise<FinalizeOnboardingRunsResult> {
  // 1. Read the rows that need finalizing. We need their ids before the
  // UPDATE so we can publish per-run cancel signals.
  const rows = await db
    .select({ id: teamRuns.id })
    .from(teamRuns)
    .where(
      and(
        eq(teamRuns.teamId, teamId),
        eq(teamRuns.trigger, 'onboarding'),
        inArray(teamRuns.status, ['pending', 'running']),
      ),
    );

  if (rows.length === 0) {
    return { finalized: 0, runIds: [] };
  }

  const runIds = rows.map((r) => r.id);

  // 2. DB flip — only flip rows that are still non-terminal. The conditional
  // matches the worker's own update guard so we don't overwrite a worker
  // that just finished a few ms before us.
  try {
    await db
      .update(teamRuns)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(
        and(
          inArray(teamRuns.id, runIds),
          not(inArray(teamRuns.status, ['completed', 'failed', 'cancelled'])),
        ),
      );
  } catch (err) {
    log.warn(
      `DB cancel update failed for team ${teamId} runs=[${runIds.join(',')}]: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 3. Cancel pub/sub fan-out. Per-run channel; failures are non-fatal —
  // the DB flip is the authoritative signal.
  const publisher = getPubSubPublisher();
  await Promise.all(
    runIds.map(async (runId) => {
      try {
        await publisher.publish(
          teamCancelChannel(teamId, runId),
          JSON.stringify({ at: Date.now(), reason: 'kickoff-handoff' }),
        );
      } catch (err) {
        log.warn(
          `Redis cancel signal failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  log.info(
    `finalized ${runIds.length} onboarding-trigger run(s) on team ${teamId} ahead of kickoff enqueue: [${runIds.join(',')}]`,
  );

  return { finalized: runIds.length, runIds };
}
