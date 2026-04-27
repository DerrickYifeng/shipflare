/**
 * Discovery v3 pipeline — the inside of the rewritten `discovery-scan`
 * processor, extracted into a pure(-ish) async function so it can be
 * unit-tested with mocked agent runs.
 *
 * Flow:
 *   1. ensureOnboardingRubric  — idempotent; only runs on first scan
 *   2. runAgent(discovery-scout) → verdicts
 *   3. decideReview → maybe runAgent(discovery-reviewer) → log disagreements
 *   4. Return the (unmodified) scout verdicts + a summary of what happened
 *
 * The processor is responsible for:
 *   - Bio filter on queue verdicts (X only)
 *   - Writing to `threads` table
 *   - SSE / pipeline events
 *
 * This split keeps the LLM-heavy side test-friendly (mock agent runs,
 * assert on inputs / decisions) without coupling tests to DB state.
 */

import { runAgent, createToolContext } from '@/bridge/agent-runner';
import { resolveAgent } from '@/tools/AgentTool/registry';
import { buildAgentConfigFromDefinition } from '@/tools/AgentTool/spawn';
import { MemoryStore } from '@/memory/store';
import {
  generateOnboardingRubric,
  ONBOARDING_RUBRIC_MEMORY_NAME,
} from './onboarding-rubric';
import { decideReview, shouldReviewRun, type ReviewDecision } from './review-gate';
import { logReviewerDisagreements, type DisagreementSummary } from './reviewer-disagreements';
import {
  discoveryScoutOutputSchema,
  type DiscoveryScoutOutput,
  type DiscoveryScoutVerdict,
} from '@/tools/AgentTool/agents/discovery-scout/schema';
import {
  discoveryReviewerOutputSchema,
  type DiscoveryReviewerOutput,
} from '@/tools/AgentTool/agents/discovery-reviewer/schema';
import { createLogger } from '@/lib/logger';
import type { UsageSummary } from '@/core/types';

const log = createLogger('lib:discovery:v3-pipeline');

export interface V3PipelineInput {
  userId: string;
  productId: string;
  platform: 'x' | 'reddit';
  sources: string[];
  intent?: string;
  /** Already-loaded product row, so the pipeline doesn't re-read it. */
  product: {
    name: string;
    description: string;
    valueProp: string | null;
    keywords: string[];
  };
  /**
   * Pre-calibrated search queries from the cached strategy doc. When
   * present, scout uses these verbatim instead of generating its own —
   * one-time `calibrate_search_strategy` does the expensive query
   * design, run_discovery_scan reuses the result on every run.
   * Empty / undefined → scout falls back to inline query generation.
   */
  presetQueries?: string[];
  /** Anti-signal terms learned during calibration; passed alongside
   *  `presetQueries` so scout knows which result patterns to deprioritise. */
  negativeTerms?: string[];
  /**
   * When `presetQueries` is empty/undefined, scout falls back to
   * inline query generation. `inlineQueryCount` (default 8) tells
   * scout how many queries to produce. Pass `12` from the kickoff
   * fast-path scan so scout deliberately spans breadth (broad +
   * medium + specific). Cron / subsequent scans omit this and let
   * scout's default kick in.
   */
  inlineQueryCount?: number;
}

export interface V3PipelineDeps {
  /** Pass-through to `runAgent` — accepts the shape of the Anthropic
   *  SDK client. Default is the real one; tests stub it. */
  xaiClient?: unknown;
  xClient?: unknown;
  redditClient?: unknown;
}

export interface V3PipelineResult {
  verdicts: DiscoveryScoutVerdict[];
  review: {
    decision: ReviewDecision;
    ran: boolean;
    disagreements?: DisagreementSummary;
    reviewerNotes?: string;
  };
  scoutNotes: string;
  usage: {
    scout: UsageSummary;
    reviewer?: UsageSummary;
  };
  rubricGenerated: boolean;
}

async function ensureOnboardingRubric(
  input: V3PipelineInput,
  store: MemoryStore,
): Promise<boolean> {
  const existing = await store.loadEntry(ONBOARDING_RUBRIC_MEMORY_NAME);
  if (existing) return false;

  log.info(`onboarding rubric missing for product ${input.productId} — generating`);
  await generateOnboardingRubric({
    userId: input.userId,
    productId: input.productId,
    product: input.product,
  });
  return true;
}

function buildScoutMessage(input: V3PipelineInput, coldStart: boolean): string {
  return JSON.stringify(
    {
      platform: input.platform,
      sources: input.sources,
      product: input.product,
      intent: input.intent ?? null,
      coldStart,
      // Calibrated queries (when set) tell scout to skip the
      // generation step and use these verbatim. See AGENT.md
      // "Workflow → presetQueries" branch.
      presetQueries: input.presetQueries ?? null,
      negativeTerms: input.negativeTerms ?? null,
      inlineQueryCount: input.inlineQueryCount ?? null,
    },
    null,
    2,
  );
}

function buildReviewerMessage(
  input: V3PipelineInput,
  verdicts: DiscoveryScoutVerdict[],
  coldStart: boolean,
): string {
  // Reviewer does NOT see scout's verdicts — only the raw thread material.
  // Strip verdict/confidence/reason fields to preserve independence.
  const threads = verdicts.map((v) => ({
    externalId: v.externalId,
    platform: v.platform,
    url: v.url,
    title: v.title,
    body: v.body,
    author: v.author,
  }));

  return JSON.stringify(
    {
      product: input.product,
      threads,
      coldStart,
      intent: input.intent ?? null,
    },
    null,
    2,
  );
}

export async function runDiscoveryV3(
  input: V3PipelineInput,
  deps: V3PipelineDeps,
): Promise<V3PipelineResult> {
  const store = new MemoryStore(input.userId, input.productId);
  const rubricGenerated = await ensureOnboardingRubric(input, store);

  const reviewDecision = await decideReview(input.userId);
  const coldStart = reviewDecision.mode === 'cold';

  // ---- Scout ----
  const scoutDef = await resolveAgent('discovery-scout');
  if (!scoutDef) {
    throw new Error('discovery-scout agent definition not found in registry');
  }
  const scoutConfig = buildAgentConfigFromDefinition(scoutDef);

  const scoutCtx = createToolContext(deps as Record<string, unknown>);
  const scoutRun = await runAgent<DiscoveryScoutOutput>(
    scoutConfig,
    buildScoutMessage(input, coldStart),
    scoutCtx,
    discoveryScoutOutputSchema,
  );

  const verdicts = scoutRun.result.verdicts;
  log.info(
    `scout ${input.platform}: ${verdicts.length} verdicts ` +
      `(${verdicts.filter((v) => v.verdict === 'queue').length} queue / ` +
      `${verdicts.filter((v) => v.verdict === 'skip').length} skip), ` +
      `cost $${scoutRun.usage.costUsd.toFixed(4)}, coldStart=${coldStart}`,
  );

  // ---- Reviewer (conditional) ----
  const shouldRunReviewer =
    verdicts.length > 0 && shouldReviewRun(reviewDecision);
  if (!shouldRunReviewer) {
    return {
      verdicts,
      review: { decision: reviewDecision, ran: false },
      scoutNotes: scoutRun.result.notes,
      usage: { scout: scoutRun.usage },
      rubricGenerated,
    };
  }

  const reviewerDef = await resolveAgent('discovery-reviewer');
  if (!reviewerDef) {
    // Missing reviewer def is a misconfiguration, not a fatal — scout
    // verdicts are still valid output. Log loudly so it doesn't silently
    // drift into production.
    log.warn(
      'discovery-reviewer agent definition not found — proceeding with scout verdicts only',
    );
    return {
      verdicts,
      review: { decision: reviewDecision, ran: false },
      scoutNotes: scoutRun.result.notes,
      usage: { scout: scoutRun.usage },
      rubricGenerated,
    };
  }
  const reviewerConfig = buildAgentConfigFromDefinition(reviewerDef);

  const reviewerCtx = createToolContext(deps as Record<string, unknown>);
  const reviewerRun = await runAgent<DiscoveryReviewerOutput>(
    reviewerConfig,
    buildReviewerMessage(input, verdicts, coldStart),
    reviewerCtx,
    discoveryReviewerOutputSchema,
  );

  const disagreements = await logReviewerDisagreements({
    userId: input.userId,
    productId: input.productId,
    scoutVerdicts: verdicts,
    reviewerJudgments: reviewerRun.result.judgments,
  });

  log.info(
    `reviewer ran on ${verdicts.length} threads: ` +
      `${disagreements.total} disagreements (${disagreements.logged} logged, ` +
      `${disagreements.skippedLowConfidence} below confidence floor, ` +
      `${disagreements.unmatched} unmatched), ` +
      `cost $${reviewerRun.usage.costUsd.toFixed(4)}`,
  );

  return {
    verdicts,
    review: {
      decision: reviewDecision,
      ran: true,
      disagreements,
      reviewerNotes: reviewerRun.result.notes,
    },
    scoutNotes: scoutRun.result.notes,
    usage: { scout: scoutRun.usage, reviewer: reviewerRun.usage },
    rubricGenerated,
  };
}
