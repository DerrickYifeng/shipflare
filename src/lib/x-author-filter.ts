/**
 * Two-stage classifier for X/Twitter author bios.
 *
 * Filters out two kinds of accounts before we draft replies under their posts:
 *   1. Growth-marketing grifters — coaches, course sellers, "daily tips"
 *      accounts, ghostwriters. Their engagement-bait posts look like genuine
 *      founder content but lead nowhere useful.
 *   2. Direct competitors — other X-growth / auto-reply / scheduling tools
 *      whose posts funnel users into their own products.
 *
 * **Stage 1 — `classifyAuthorBio`** (regex rules, 0 cost): catches obvious
 * grifter / competitor bios in microseconds. Deliberately conservative —
 * only blocks on unambiguous keywords.
 *
 * **Stage 2 — `judgeAuthorsWithLLM`** (Claude Haiku, ~$0.0004/call): judges
 * ambiguous bios against the user's product context. An account that reads
 * "growth marketer" might be a direct competitor for ShipFlare but the exact
 * target ICP for a "teach AI to founders" product — the LLM handles that
 * disambiguation using the product description.
 *
 * The R8 register in x-reply-rules.md is the content-level safety net for
 * growth-bait posts that sneak past both stages (new accounts, hidden bios).
 */

import { z } from 'zod';
import { createMessage, calculateCost } from '@/core/api-client';
import { createLogger } from './logger';
import type { UsageSummary } from '@/core/types';

const log = createLogger('lib:x-author-filter');

export interface CompetitorMatch {
  isCompetitor: boolean;
  reason: string | null;
}

// Growth-marketing / grifter patterns. Matches on the normalized bio.
const GROWTH_GRIFTER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bgrowth (marketer|hacker|expert|coach)\b/i, label: 'growth marketer bio' },
  { pattern: /\b(teach|teaching|teaches) (you |me )?(how to |to )?(grow|write|ship|build|scale)\b/i, label: 'teaches-to-X bio' },
  { pattern: /\b(coach|mentor)(ing)?\s+(founders?|creators?|builders?|writers?)\b/i, label: 'coach/mentor bio' },
  { pattern: /\bghost\s*writ(er|ers|ing)\b/i, label: 'ghostwriter bio' },
  { pattern: /\bfree\s+(blueprint|guide|template|playbook|ebook|course|framework)\b/i, label: 'free-lead-magnet bio' },
  { pattern: /\bmake\s+money\s+(as\s+a|writing|online|from|with)\b/i, label: 'make-money-online bio' },
  { pattern: /\b(copywriter|copy\s*writer)\b/i, label: 'copywriter bio' },
  { pattern: /\bthreads?\s+(writer|guy|expert)\b/i, label: 'threads writer bio' },
  { pattern: /\bdigital writing\b/i, label: 'digital-writing niche' },
  { pattern: /\btalks?\s+about\s+(writing|growth|money|business|internet|online|startups?|content)\b/i, label: 'talks-about-X bio' },
  { pattern: /\bwriter\s*[&+]\s*(operator|coach|consultant|creator)\b/i, label: 'writer-plus-X identity' },
  { pattern: /\b(content\s+strategist|email\s+marketer|seo\s+expert|growth\s+strategist)\b/i, label: 'commodity-niche bio' },
  { pattern: /\bget\s+(more|your)\s+(clients|customers|leads|subscribers|followers)\s+(from|with|using|through|via)\b/i, label: 'lead-gen funnel bio' },
  { pattern: /\bdaily (tips|threads|tweets|insights)\b/i, label: 'daily-tips bio' },
  { pattern: /\bfollow (me |for )(daily|tips|threads|growth)/i, label: 'follow-for-X bio' },
  { pattern: /\b(playbook|masterclass|cohort|bootcamp)s?\b/i, label: 'course/cohort bio' },
  { pattern: /\bDM\s+(me )?(for|to learn)/i, label: 'DM-for-X bio' },
  // Course / creator-economy domains often link from bio.
  { pattern: /\b(gumroad\.com|beehiiv\.com|teachable\.com|kajabi\.com|stan\.store|convertkit\.com|maven\.com)\b/i, label: 'creator-economy link' },
];

// Direct competitor patterns — other products in ShipFlare's category
// (X growth automation, AI reply tools, tweet scheduling with AI).
const DIRECT_COMPETITOR_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(tweet hunter|tweethunter)\b/i, label: 'Tweet Hunter team/bio' },
  { pattern: /\btypefully\b/i, label: 'Typefully team/bio' },
  { pattern: /\bhypefury\b/i, label: 'Hypefury team/bio' },
  { pattern: /\btaplio\b/i, label: 'Taplio team/bio' },
  { pattern: /\b(postbridge|post bridge)\b/i, label: 'Post Bridge team/bio' },
  { pattern: /\b(buffer|hootsuite)\b/i, label: 'scheduler-category bio' },
  { pattern: /\bAI (reply|replies|engagement) (tool|bot|platform)\b/i, label: 'AI-reply-tool bio' },
  { pattern: /\bauto[-\s]?(reply|engagement|tweet)\b/i, label: 'auto-reply-tool bio' },
];

/**
 * Classify an author bio as competitor / grifter vs. genuine.
 * Returns the first matching pattern's label as the reason.
 */
export const classifyAuthorBio = (bio: string | null | undefined): CompetitorMatch => {
  if (!bio || !bio.trim()) return { isCompetitor: false, reason: null };

  for (const { pattern, label } of DIRECT_COMPETITOR_PATTERNS) {
    if (pattern.test(bio)) return { isCompetitor: true, reason: label };
  }
  for (const { pattern, label } of GROWTH_GRIFTER_PATTERNS) {
    if (pattern.test(bio)) return { isCompetitor: true, reason: label };
  }

  return { isCompetitor: false, reason: null };
};

// ---------------------------------------------------------------------------
// Stage 2 — LLM judge (Haiku 4.5)
// ---------------------------------------------------------------------------

const LLM_MODEL = 'claude-haiku-4-5-20251001';

export interface AuthorBioInput {
  username: string;
  bio: string | null;
}

export interface AuthorVerdict {
  username: string;
  isCompetitor: boolean;
  reason: string;
  decidedBy: 'rule' | 'llm' | 'default';
}

export interface ProductContext {
  name: string;
  description: string;
  valueProp: string | null;
}

const JUDGE_SYSTEM = `You decide whether replying under an X/Twitter account's posts is valuable growth exposure for a specific product.

You will be given the product's context (name, description, value prop) and a batch of author bios. For each author, judge THIS product specifically. Do not apply generic rules — reason from the product's actual target audience and category.

**Default: PASS.** Replying under most accounts is net-positive exposure for a growth product. Only block when you have strong, specific reasons based on the product context.

**Block (isCompetitor=true) when BOTH are true:**
1. The author's *primary* identity (the dominant signal in their bio) is either:
   - A direct category competitor of the product, OR
   - A pure commodity-info creator whose monetization is an info-product (course, cohort, ghostwriting service, newsletter funnel, coaching package) with NO real product/SaaS/startup behind it.
2. AND replying under their posts plausibly hurts the user — either funnels into a competitor, or reaches an audience already saturated with similar paid offerings.

**Explicitly PASS — do not block:**
- Founders who build real products AND *also* run a podcast, newsletter, community, or content brand on the side. Hybrid identity is normal.
- Fund / VC / holdco operators with real portfolio companies (even if they also sell content or advice).
- Creators whose audience overlaps with the product's ICP, even if they sell a course alongside real work.
- Anyone whose bio you cannot unambiguously categorize. When in doubt, pass — the reply-drafter has downstream safeguards for bait content.

The goal is to filter out *only* the clearly counterproductive accounts: direct product competitors, and pure grifters with no underlying product. Everyone else — including borderline hybrid founders — should pass.

Output a short reason (<= 10 words) explaining the verdict — e.g. "direct competitor — tweet scheduling tool", "sells writing course, no product", "indie founder with multiple products", "fund operator, pass", "hybrid builder with real portfolio".`;

const judgeOutputSchema = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          username: { type: 'string' },
          isCompetitor: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['username', 'isCompetitor', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
} as const;

const parsedVerdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      username: z.string(),
      isCompetitor: z.boolean(),
      reason: z.string(),
    }),
  ),
});

/**
 * Batch-judge author bios using Claude Haiku with the user's product context.
 *
 * Pass only ambiguous bios that rule-based `classifyAuthorBio` didn't already
 * flag — the regex layer catches the obvious cases for free.
 */
export const judgeAuthorsWithLLM = async (
  product: ProductContext,
  authors: AuthorBioInput[],
): Promise<{ verdicts: AuthorVerdict[]; usage: UsageSummary }> => {
  if (authors.length === 0) {
    return {
      verdicts: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        model: LLM_MODEL,
        turns: 0,
      },
    };
  }

  const userPayload = JSON.stringify(
    {
      product: {
        name: product.name,
        description: product.description,
        valueProp: product.valueProp,
      },
      authors: authors.map((a) => ({
        username: a.username,
        bio: a.bio ?? '',
      })),
    },
    null,
    2,
  );

  const { response, usage: rawUsage } = await createMessage({
    model: LLM_MODEL,
    system: JUDGE_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Product the user is trying to grow:\n- Name: ${product.name}\n- Description: ${product.description}\n- Value prop: ${product.valueProp ?? '(none provided)'}\n\nFor each author below, decide whether replying under their posts is useful reach (isCompetitor=false, PASS) or counterproductive (isCompetitor=true, BLOCK) for THIS product specifically.\n\nRemember: default to PASS. Only block direct competitors or pure-grifter accounts with no real product.\n\n${userPayload}`,
      },
    ],
    maxTokens: 1024,
    promptCaching: false,
    outputSchema: judgeOutputSchema,
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  const usage: UsageSummary = {
    ...rawUsage,
    costUsd: calculateCost(LLM_MODEL, rawUsage),
    model: LLM_MODEL,
    turns: 1,
  };

  let parsed: z.infer<typeof parsedVerdictsSchema>;
  try {
    parsed = parsedVerdictsSchema.parse(JSON.parse(text));
  } catch (err) {
    log.warn(
      `LLM judge returned unparseable output (${(err as Error).message}); defaulting ${authors.length} authors to pass`,
    );
    return {
      verdicts: authors.map((a) => ({
        username: a.username,
        isCompetitor: false,
        reason: 'llm parse fail — default pass',
        decidedBy: 'default',
      })),
      usage,
    };
  }

  const byHandle = new Map(
    parsed.verdicts.map((v) => [v.username.toLowerCase().replace(/^@/, ''), v]),
  );

  const verdicts: AuthorVerdict[] = authors.map((a) => {
    const match = byHandle.get(a.username.toLowerCase().replace(/^@/, ''));
    if (!match) {
      return {
        username: a.username,
        isCompetitor: false,
        reason: 'llm skipped — default pass',
        decidedBy: 'default',
      };
    }
    return {
      username: a.username,
      isCompetitor: match.isCompetitor,
      reason: match.reason,
      decidedBy: 'llm',
    };
  });

  log.info(
    `LLM judged ${verdicts.length} authors: ${verdicts.filter((v) => v.isCompetitor).length} blocked, cost $${usage.costUsd.toFixed(4)}`,
  );

  return { verdicts, usage };
};
