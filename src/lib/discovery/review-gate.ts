/**
 * Review-gate — decides whether the discovery-reviewer agent runs for a
 * given user on a given `run_discovery_scan` tool invocation.
 *
 * Three-phase fade-out based on how much real user feedback (approve /
 * skip / post actions on past discovered threads) has accumulated:
 *
 *   labelCount <  COLD_THRESHOLD   → cold: reviewer on every run
 *   labelCount <  HOT_THRESHOLD    → warm: reviewer samples 10% of runs
 *   labelCount >= HOT_THRESHOLD    → hot:  reviewer off
 *
 * Thresholds were chosen in the v3 plan (see CLAUDE.md TODO log): 30
 * labels is the point where a user's approve/skip signal is stable
 * enough that Sonnet-anchoring adds little; 100 labels is where it
 * adds nothing. Numbers are conservative on purpose — the cost of
 * running reviewer too long (Sonnet tokens) is lower than the cost
 * of turning it off too early (scout drifting without a corrective
 * signal).
 *
 * Ground-truth source: `thread_feedback` table, which is written by
 * `/api/discovery/approve` on every user approve / skip / post action.
 * Product-scoped counts aren't currently available — that table
 * stores (userId, threadId) without a productId, and `threads` rows
 * also lack a productId column. For now the count is per-user, which
 * matches the "1 product per user" assumption the rest of the
 * processor code already makes (see discovery-cron-fanout.ts).
 */

import { db } from '@/lib/db';
import { threadFeedback } from '@/lib/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';

export const COLD_THRESHOLD = 30;
export const HOT_THRESHOLD = 100;

export type ReviewMode = 'cold' | 'warm' | 'hot';

export interface ReviewDecision {
  mode: ReviewMode;
  /** 0..1 — probability that reviewer should run this invocation. */
  sampleRate: number;
  /** Raw label count used to decide. Returned for logging / UI. */
  labelCount: number;
}

/**
 * Actions that count as "user gave us a label". `post` is a superset
 * of `approve` in the current pipeline (user approved, then the
 * post went out), but both are legitimate label signals for
 * gate-decision purposes.
 */
const LABEL_ACTIONS = ['approve', 'skip', 'post'] as const;

async function countUserLabels(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(threadFeedback)
    .where(
      and(
        eq(threadFeedback.userId, userId),
        inArray(threadFeedback.userAction, LABEL_ACTIONS as unknown as string[]),
      ),
    );
  return row?.count ?? 0;
}

export function decideReviewMode(labelCount: number): ReviewDecision {
  if (labelCount < COLD_THRESHOLD) {
    return { mode: 'cold', sampleRate: 1.0, labelCount };
  }
  if (labelCount < HOT_THRESHOLD) {
    return { mode: 'warm', sampleRate: 0.1, labelCount };
  }
  return { mode: 'hot', sampleRate: 0, labelCount };
}

export async function decideReview(userId: string): Promise<ReviewDecision> {
  const labelCount = await countUserLabels(userId);
  return decideReviewMode(labelCount);
}

/**
 * Should the reviewer actually run for this invocation, given the
 * decision? Pure function — caller passes a seeded RNG (e.g. `Math.random`)
 * or a deterministic value in tests. Defaults to `Math.random()`.
 *
 * Extracted from `decideReview` so the decision is cacheable and the
 * sampling roll is explicit at the call site.
 */
export function shouldReviewRun(
  decision: ReviewDecision,
  rng: () => number = Math.random,
): boolean {
  if (decision.sampleRate >= 1) return true;
  if (decision.sampleRate <= 0) return false;
  return rng() < decision.sampleRate;
}
