/**
 * Persist `queue` verdicts emitted by the discovery-scout agent into
 * the `threads` table.
 *
 * Two callers:
 *  - `src/tools/RunDiscoveryScanTool/RunDiscoveryScanTool.ts` — the
 *    `run_discovery_scan` tool that wraps the v3 pipeline; invoked from
 *    the team-run loop on `discovery_cron` triggers (fanned out by
 *    `src/workers/processors/discovery-cron-fanout.ts`) and from manual
 *    scan triggers.
 *  - `src/tools/AgentTool/AgentTool.ts` — the coordinator-invoked path
 *    (Task(subagent_type: 'discovery-scout')). Before this helper
 *    existed, subagent invocations surfaced verdicts to the
 *    coordinator but never hit the DB, which left `find_threads`
 *    with an empty inbox on the follow-up turn.
 *
 * Inserts use `onConflictDoNothing` on `(userId, platform, externalId)`
 * so a re-scan of the same candidates is a no-op instead of a
 * unique-constraint violation.
 *
 * `skip` verdicts are intentionally dropped on the floor here; the
 * caller may still want to emit them as pipeline events for
 * observability, but that's not this helper's job.
 */
import { db as defaultDb, type Database } from '@/lib/db';
import { threads } from '@/lib/db/schema';
import type { DiscoveryScoutVerdict } from '@/tools/AgentTool/agents/discovery-scout/schema';

export interface PersistScoutVerdictsInput {
  userId: string;
  verdicts: readonly DiscoveryScoutVerdict[];
  db?: Database;
}

export interface PersistScoutVerdictsResult {
  /** Number of verdicts with verdict: 'queue' that were passed in. */
  queued: number;
}

export async function persistScoutVerdicts(
  input: PersistScoutVerdictsInput,
): Promise<PersistScoutVerdictsResult> {
  const d = input.db ?? defaultDb;
  const queue = input.verdicts.filter((v) => v.verdict === 'queue');
  if (queue.length === 0) {
    return { queued: 0 };
  }

  const rows = queue.map((v) => ({
    userId: input.userId,
    externalId: v.externalId,
    platform: v.platform,
    // `community` is a legacy per-platform category used for reddit
    // subreddits. Scout doesn't emit it today, so fall back to the
    // platform id so the column stays non-null.
    community: v.platform,
    title: v.title ?? '',
    body: v.body,
    author: v.author,
    url: v.url,
    scoutConfidence: v.confidence,
    scoutReason: v.reason,
    state: 'queued' as const,
  }));

  await d
    .insert(threads)
    .values(rows)
    .onConflictDoNothing({
      target: [threads.userId, threads.platform, threads.externalId],
    });

  return { queued: queue.length };
}
