import { z } from 'zod';
import { buildTool } from '@/bridge/build-tool';

// ---------------------------------------------------------------------------
// Score formulas (extracted from src/app/api/scan/route.ts)
// ---------------------------------------------------------------------------

const SCORE_WEIGHTS = {
  relevance: 0.30,
  intent: 0.45,
  exposure: 0.10,
  freshness: 0.10,
  engagement: 0.05,
};

function scoreExposure(upvotes: number, comments: number): number {
  const total = Math.max(upvotes, 0) + Math.max(comments, 0);
  if (total <= 0) return 0.05;
  return Math.min(1.0, Math.log10(total + 1) / 3);
}

function scoreFreshness(createdUtc: number): number {
  const ageHours = (Date.now() / 1000 - createdUtc) / 3600;
  if (ageHours <= 0) return 1.0;
  return Math.max(0.05, Math.exp(-0.046 * ageHours));
}

function scoreEngagement(upvotes: number, comments: number): number {
  if (comments <= 0) return 0.05;
  const commentScore = Math.min(1.0, Math.log10(comments + 1) / 2.5);
  const ratio = upvotes > 0 ? comments / upvotes : 1;
  const ratioBonus = Math.min(0.3, ratio * 0.15);
  return Math.min(1.0, commentScore + ratioBonus);
}

function computeWeightedScore(
  dims: {
    relevance: number;
    intent: number;
    exposure: number;
    freshness: number;
    engagement: number;
  },
  weights: typeof SCORE_WEIGHTS = SCORE_WEIGHTS,
): number {
  return (
    dims.relevance * weights.relevance +
    dims.intent * weights.intent +
    dims.exposure * weights.exposure +
    dims.freshness * weights.freshness +
    dims.engagement * weights.engagement
  );
}

// ---------------------------------------------------------------------------
// Thread input schema
// ---------------------------------------------------------------------------

const threadInputSchema = z.object({
  id: z.string(),
  community: z.string(),
  title: z.string(),
  url: z.string(),
  relevance: z.number().min(0).max(1).describe('AI-assessed relevance (0-1)'),
  intent: z.number().min(0).max(1).describe('AI-assessed intent (0-1)'),
  score: z.number().nullable().optional().describe('Upvotes'),
  commentCount: z.number().nullable().optional().describe('Number of comments'),
  createdUtc: z.number().nullable().optional().describe('Unix timestamp of creation'),
  reason: z.string().describe('Why this thread is relevant'),
  // Optional pass-through fields for UI display on the Today reply card.
  // Reddit: body = selftext; X: body = tweet text. Truncated by the
  // upstream search tool; we do not re-truncate.
  body: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  postedAt: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const scoreThreadsTool = buildTool({
  name: 'score_threads',
  description:
    'Apply weighted multi-dimensional scoring to threads. Input must be {"threads": [...array of thread objects...]}. Each thread needs: id, community, title, url, relevance (0-1), intent (0-1), reason. Returns threads sorted by weighted score.',
  isConcurrencySafe: true,
  isReadOnly: true,
  inputSchema: z.object({
    threads: z.array(threadInputSchema),
    config: z
      .object({
        weights: z
          .object({
            relevance: z.number().nullable().optional(),
            intent: z.number().nullable().optional(),
            exposure: z.number().nullable().optional(),
            freshness: z.number().nullable().optional(),
            engagement: z.number().nullable().optional(),
          })
          .optional(),
        intentGate: z.number().nullable().optional(),
        relevanceGate: z.number().nullable().optional(),
        gateCap: z.number().nullable().optional(),
      })
      .optional()
      .describe('Per-user scoring config overrides'),
  }),
  async execute(input) {
    const weights = input.config?.weights
      ? {
          relevance: input.config.weights.relevance ?? SCORE_WEIGHTS.relevance,
          intent: input.config.weights.intent ?? SCORE_WEIGHTS.intent,
          exposure: input.config.weights.exposure ?? SCORE_WEIGHTS.exposure,
          freshness: input.config.weights.freshness ?? SCORE_WEIGHTS.freshness,
          engagement: input.config.weights.engagement ?? SCORE_WEIGHTS.engagement,
        }
      : SCORE_WEIGHTS;
    const intentGateThreshold = input.config?.intentGate ?? 0.5;
    const relevanceGateThreshold = input.config?.relevanceGate ?? 0.5;
    const gateCapValue = input.config?.gateCap ?? 0.45;

    const scored = input.threads.map((t) => {
      const dims = {
        relevance: t.relevance,
        intent: t.intent,
        exposure: scoreExposure(t.score ?? 0, t.commentCount ?? 0),
        freshness: scoreFreshness(t.createdUtc ?? 0),
        engagement: scoreEngagement(t.score ?? 0, t.commentCount ?? 0),
      };
      let weightedScore = computeWeightedScore(dims, weights);

      // Intent gate: if the author isn't seeking help, cap the score.
      // Same for relevance: topic overlap alone isn't enough.
      if (dims.intent < intentGateThreshold || dims.relevance < relevanceGateThreshold) {
        weightedScore = Math.min(weightedScore, gateCapValue);
      }

      return {
        id: t.id,
        community: t.community,
        title: t.title,
        url: t.url,
        relevanceScore: Math.round(weightedScore * 100),
        scores: {
          relevance: Math.round(dims.relevance * 100),
          intent: Math.round(dims.intent * 100),
          exposure: Math.round(dims.exposure * 100),
          freshness: Math.round(dims.freshness * 100),
          engagement: Math.round(dims.engagement * 100),
        },
        score: t.score ?? 0,
        commentCount: t.commentCount ?? 0,
        createdUtc: t.createdUtc ?? 0,
        reason: t.reason,
        body: t.body ?? undefined,
        author: t.author ?? undefined,
        postedAt: t.postedAt ?? undefined,
      };
    });

    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return { threads: scored };
  },
});
