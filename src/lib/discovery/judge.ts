import { z } from 'zod';
import { createMessage, calculateCost } from '@/core/api-client';
import { createLogger } from '@/lib/logger';
import type { UsageSummary } from '@/core/types';

const log = createLogger('discovery:judge');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoredThread {
  id: string;
  title: string;
  community: string;
  url: string;
  relevanceScore: number;
  scores?: {
    relevance: number;
    intent: number;
    exposure?: number;
    freshness?: number;
    engagement?: number;
  };
  reason?: string;
}

export interface Judgment {
  id: string;
  isPotentialUser: boolean;
  reason: string;
  thread: ScoredThread;
}

interface ProductContext {
  name: string;
  description: string;
  valueProp: string | null;
}

// ---------------------------------------------------------------------------
// Judge system prompt
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM = `You evaluate whether a thread/post author is a potential user of a product.

A "potential user" satisfies ALL THREE criteria:
1. Has a pain point that the product specifically solves (same sub-domain, not just same industry)
2. Is open to solutions (asking questions, seeking tools, describing struggles, venting frustration they haven't solved)
3. Is NOT a competitor promoting their own solution, a curator listing tools, or an advisor/teacher sharing what already worked

For each thread, respond with a JSON object containing your judgments.

Be strict: if the author is teaching, sharing advice, doing a retrospective, or promoting something, they are NOT a potential user even if the topic overlaps.`;

// ---------------------------------------------------------------------------
// Output schema for structured JSON
// ---------------------------------------------------------------------------

const judgeOutputSchema = z.object({
  judgments: z.array(
    z.object({
      id: z.string(),
      isPotentialUser: z.boolean(),
      reason: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MODEL = 'claude-haiku-4-5-20251001';

/**
 * Batch-evaluate threads: "Is this author a potential user of {product}?"
 *
 * Uses a single Haiku call for cost efficiency. Returns YES/NO with reason
 * for each thread, plus aggregated usage stats.
 */
export async function judgeThreadsBatch(
  product: ProductContext,
  threads: ScoredThread[],
  _platform: string,
): Promise<{ judgments: Judgment[]; usage: UsageSummary }> {
  if (threads.length === 0) {
    return {
      judgments: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        model: MODEL,
        turns: 0,
      },
    };
  }

  const userMessage = JSON.stringify({
    product: {
      name: product.name,
      description: product.description,
      valueProp: product.valueProp,
    },
    threads: threads.map((t) => ({
      id: t.id,
      title: t.title,
      community: t.community,
      reason: t.reason,
      scores: t.scores,
    })),
  });

  const { response, usage: rawUsage } = await createMessage({
    model: MODEL,
    system: JUDGE_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Evaluate each thread. For each, answer: is the author a potential user of "${product.name}"?\n\n${userMessage}`,
      },
    ],
    maxTokens: 4096,
    promptCaching: false,
    outputSchema: zodToJsonSchema(judgeOutputSchema),
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  let parsed: z.infer<typeof judgeOutputSchema>;
  try {
    parsed = judgeOutputSchema.parse(JSON.parse(text));
  } catch (err) {
    log.error(`Failed to parse judge output: ${err}`);
    return {
      judgments: [],
      usage: {
        ...rawUsage,
        costUsd: calculateCost(MODEL, rawUsage),
        model: MODEL,
        turns: 1,
      },
    };
  }

  const judgments: Judgment[] = parsed.judgments
    .map((j) => {
      const thread = threads.find((t) => t.id === j.id);
      if (!thread) return null;
      return { ...j, thread };
    })
    .filter((j): j is Judgment => j !== null);

  log.info(
    `Judged ${judgments.length} threads: ${judgments.filter((j) => j.isPotentialUser).length} potential users`,
  );

  return {
    judgments,
    usage: {
      ...rawUsage,
      costUsd: calculateCost(MODEL, rawUsage),
      model: MODEL,
      turns: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: convert Zod schema to JSON Schema for outputSchema
// ---------------------------------------------------------------------------

function zodToJsonSchema(_schema: z.ZodType): Record<string, unknown> {
  // Minimal conversion for the specific judge schema.
  // Anthropic output_config.format.schema expects raw JSON Schema (no wrapper).
  return {
    type: 'object',
    properties: {
      judgments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            isPotentialUser: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['id', 'isPotentialUser', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['judgments'],
    additionalProperties: false,
  };
}
