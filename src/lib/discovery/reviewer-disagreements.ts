/**
 * Turn scout-vs-reviewer disagreements into entries in `agent_memory_logs`
 * so the nightly dream distill can fold them into feedback memories.
 *
 * This is the seam that lets the reviewer improve scout's future runs
 * without any scalar weight tuning: a disagreement becomes an
 * addressable log entry; distill reads them, reconciles with real user
 * approve/skip labels, and writes a `type: 'feedback'` memory that
 * scout reads on its next invocation.
 *
 * Log entry format is intentionally unstructured markdown — the dream
 * prompt already handles free-form entries. We tag each line with
 * `[reviewer-disagreement]` so distill can filter origin.
 */

import type { DiscoveryScoutVerdict } from '@/tools/AgentTool/agents/discovery-scout/schema';
import type { DiscoveryReviewerJudgment } from '@/tools/AgentTool/agents/discovery-reviewer/schema';
import { MemoryStore } from '@/memory/store';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:discovery:reviewer-disagreements');

/**
 * Minimum confidence reviewer must have for a disagreement to be worth
 * logging. Low-confidence reviewer verdicts are noise — logging them
 * would train scout on reviewer's coin-flips.
 */
export const MIN_REVIEWER_CONFIDENCE = 0.6;

export interface DisagreementLogInput {
  userId: string;
  productId: string;
  scoutVerdicts: readonly DiscoveryScoutVerdict[];
  reviewerJudgments: readonly DiscoveryReviewerJudgment[];
}

export interface DisagreementSummary {
  total: number;
  logged: number;
  skippedLowConfidence: number;
  unmatched: number;
}

interface Pair {
  externalId: string;
  scout: DiscoveryScoutVerdict;
  reviewer: DiscoveryReviewerJudgment;
}

/**
 * Zip the two lists by externalId. Entries present on only one side
 * are tracked separately (returned via the caller's summary) — they
 * should never happen in a healthy pipeline; the discovery-scan
 * processor is expected to give reviewer the exact scout-candidate
 * set.
 */
function pairByExternalId(
  scoutVerdicts: readonly DiscoveryScoutVerdict[],
  reviewerJudgments: readonly DiscoveryReviewerJudgment[],
): { pairs: Pair[]; unmatchedCount: number } {
  const reviewerById = new Map<string, DiscoveryReviewerJudgment>();
  for (const j of reviewerJudgments) reviewerById.set(j.externalId, j);

  const pairs: Pair[] = [];
  let unmatchedCount = 0;
  const seenScoutIds = new Set<string>();

  for (const s of scoutVerdicts) {
    seenScoutIds.add(s.externalId);
    const r = reviewerById.get(s.externalId);
    if (!r) {
      unmatchedCount += 1;
      continue;
    }
    pairs.push({ externalId: s.externalId, scout: s, reviewer: r });
  }

  for (const id of reviewerById.keys()) {
    if (!seenScoutIds.has(id)) unmatchedCount += 1;
  }

  return { pairs, unmatchedCount };
}

function formatLogEntry(pair: Pair): string {
  const { scout, reviewer } = pair;
  // Keep it greppable: prefix tag + url first so `appendLog` dumps are
  // easy to scan; verdicts + reasoning come after.
  return [
    '[reviewer-disagreement]',
    `url=${scout.url}`,
    `platform=${scout.platform}`,
    `scout=${scout.verdict}(${scout.confidence.toFixed(2)}) ${JSON.stringify(scout.reason)}`,
    `reviewer=${reviewer.verdict}(${reviewer.confidence.toFixed(2)}) ${JSON.stringify(reviewer.reasoning)}`,
  ].join(' | ');
}

/**
 * Compare scout and reviewer output; for each disagreement above the
 * confidence floor, append a log entry. Returns a summary the caller
 * can emit as a pipeline event / metric.
 *
 * This function is side-effectful (writes to `agent_memory_logs`) but
 * safe to call from the discovery-scan processor — failures are logged
 * and swallowed; a broken memory write must not fail the scan.
 */
export async function logReviewerDisagreements(
  input: DisagreementLogInput,
): Promise<DisagreementSummary> {
  const { pairs, unmatchedCount } = pairByExternalId(
    input.scoutVerdicts,
    input.reviewerJudgments,
  );

  const disagreements = pairs.filter(
    (p) => p.scout.verdict !== p.reviewer.verdict,
  );

  const worthLogging = disagreements.filter(
    (p) => p.reviewer.confidence >= MIN_REVIEWER_CONFIDENCE,
  );
  const skippedLowConfidence = disagreements.length - worthLogging.length;

  if (worthLogging.length === 0) {
    return {
      total: disagreements.length,
      logged: 0,
      skippedLowConfidence,
      unmatched: unmatchedCount,
    };
  }

  const store = new MemoryStore(input.userId, input.productId);
  let logged = 0;

  for (const pair of worthLogging) {
    try {
      await store.appendLog(formatLogEntry(pair));
      logged += 1;
    } catch (err) {
      log.warn(
        `appendLog failed for disagreement on ${pair.externalId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    total: disagreements.length,
    logged,
    skippedLowConfidence,
    unmatched: unmatchedCount,
  };
}
