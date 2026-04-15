import { z } from 'zod';
import { createMessage, calculateCost } from '@/core/api-client';
import { createLogger } from '@/lib/logger';
import type { UsageSummary } from '@/core/types';
import type { Judgment } from './judge';

const log = createLogger('discovery:optimizer');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProductContext {
  name: string;
  description: string;
  valueProp: string | null;
}

interface CurrentConfig {
  weights: {
    relevance: number;
    intent: number;
    exposure: number;
    freshness: number;
    engagement: number;
  };
  intentGate: number;
  relevanceGate: number;
  gateCap: number;
  strategyRules: string | null;
  customLowRelevancePatterns: string | null;
  customPainPhrases: string[];
  customQueryTemplates: string[];
}

interface CalibrationLogEntry {
  round: number;
  precision: number | null;
  evaluated: number;
  changes: string;
  appliedChanges?: string;
  timestamp: string;
}

export interface OptimizerInput {
  product: ProductContext;
  platform: string;
  currentConfig: CurrentConfig;
  falsePositives: (Judgment & { judgeReason: string })[];
  truePositives: (Judgment & { judgeReason: string })[];
  precision: number;
  round: number;
  previousLog: CalibrationLogEntry[];
}

export interface OptimizerResult {
  analysis: string;
  numericChanges?: Record<string, number>;
  strategyRules?: string;
  customLowRelevancePatterns?: string;
  customPainPhrases?: string[];
  customQueryTemplates?: string[];
  platformStrategyOverride?: string;
  undoFromPreviousRound?: string[];
}

// ---------------------------------------------------------------------------
// Optimizer system prompt
// ---------------------------------------------------------------------------

const OPTIMIZER_SYSTEM = `You are a Discovery Optimization Agent. You analyze why false-positive threads were surfaced and generate targeted strategy edits to improve precision.

## Input

- Product context (name, description, valueProp)
- Platform being optimized
- Current config (weights, thresholds, existing strategy rules)
- False positives: threads the judge said are NOT potential users (with reasons)
- True positives: threads the judge confirmed ARE potential users
- Current precision rate
- Calibration round number and history of previous rounds

## Your Task

1. **Analyze failure patterns** in the false positives. Group by root cause:
   - Wrong sub-domain (topic overlaps but author's specific need doesn't match)
   - Teaching/sharing (author giving advice, not seeking help)
   - Competitor self-promotion
   - Generic venting without actionable pain point
   - Other pattern (describe it)

2. **For each pattern, choose the right fix type**:

   a. **Strategy rule** (highest impact): Write a product-specific rule the discovery agent should follow.
      Example: "For this scheduling tool, threads about project management methodology are irrelevant"

   b. **Query fix**: Add custom pain phrases that better match this product's users. Remove/replace queries that attract the wrong audience.

   c. **Numeric fix** (adjust scoring math): Tune weights or thresholds only if the pattern is systematic.

   d. **Low-relevance pattern** (blocklist): Specific topics/patterns that should always score low for this product.

3. **Review previous rounds** (in the calibration history). Don't repeat changes that didn't work. If a previous fix made precision worse, undo it.

## Constraints

- Strategy rules MUST be specific to this product's domain, not generic.
- Custom queries MUST target question-askers and struggle-describers.
- Be incremental: make 1-3 targeted changes per round, not wholesale rewrites.
- If precision is already 70%+, make only surgical adjustments.
- If a round's changes made things worse (check history), revert that change.`;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const optimizerOutputSchema = z.object({
  analysis: z.string(),
  numericChanges: z.record(z.number()).optional(),
  strategyRules: z.string().optional(),
  customLowRelevancePatterns: z.string().optional(),
  customPainPhrases: z.array(z.string()).optional(),
  customQueryTemplates: z.array(z.string()).optional(),
  platformStrategyOverride: z.string().optional(),
  undoFromPreviousRound: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-4-6';

/**
 * Run the optimizer: analyze false positives and generate strategy edits.
 *
 * Uses a single Sonnet call. Sees the full calibration history so it can
 * learn from previous rounds and avoid repeating failed changes.
 */
export async function runOptimizer(
  input: OptimizerInput,
): Promise<{ result: OptimizerResult; usage: UsageSummary }> {
  const userMessage = JSON.stringify({
    product: input.product,
    platform: input.platform,
    currentConfig: input.currentConfig,
    falsePositives: input.falsePositives.map((fp) => ({
      id: fp.id,
      title: fp.thread.title,
      community: fp.thread.community,
      scores: fp.thread.scores,
      judgeReason: fp.judgeReason,
    })),
    truePositives: input.truePositives.map((tp) => ({
      id: tp.id,
      title: tp.thread.title,
      community: tp.thread.community,
      scores: tp.thread.scores,
      judgeReason: tp.judgeReason,
    })),
    precision: input.precision,
    round: input.round,
    previousLog: input.previousLog,
  });

  const { response, usage: rawUsage } = await createMessage({
    model: MODEL,
    system: OPTIMIZER_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Analyze the discovery results and generate strategy edits to improve precision from ${(input.precision * 100).toFixed(0)}% toward 80%+.\n\n${userMessage}`,
      },
    ],
    maxTokens: 4096,
    promptCaching: false,
    outputSchema: {
      name: 'optimizer_output',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          analysis: { type: 'string' },
          numericChanges: {
            type: 'object',
            additionalProperties: { type: 'number' },
          },
          strategyRules: { type: 'string' },
          customLowRelevancePatterns: { type: 'string' },
          customPainPhrases: {
            type: 'array',
            items: { type: 'string' },
          },
          customQueryTemplates: {
            type: 'array',
            items: { type: 'string' },
          },
          platformStrategyOverride: { type: 'string' },
          undoFromPreviousRound: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['analysis'],
        additionalProperties: false,
      },
    },
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  let parsed: OptimizerResult;
  try {
    parsed = optimizerOutputSchema.parse(JSON.parse(text));
  } catch (err) {
    log.error(`Failed to parse optimizer output: ${err}`);
    parsed = { analysis: 'Failed to parse optimizer output' };
  }

  log.info(`Optimizer analysis: ${parsed.analysis}`);

  return {
    result: parsed,
    usage: {
      ...rawUsage,
      costUsd: calculateCost(MODEL, rawUsage),
      model: MODEL,
      turns: 1,
    },
  };
}
