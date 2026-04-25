/**
 * Two-stage classifier for X/Twitter author bios. Product-agnostic by design:
 * the rules layer only blocks universal spam signals that are bad reply
 * targets for ANY product; anything product-specific (category competitors,
 * niche grifters whose audience might actually be the user's ICP) is
 * delegated to the LLM stage with the user's product context.
 *
 * **Stage 1 — `classifyAuthorBio`** (regex rules, 0 cost): catches universal
 * spam bios — engagement-pod operators, follow-for-follow traders, crypto
 * pump accounts, unbranded lead-gen funnels ("DM me to make $10k/mo").
 * Never blocks on tokens that could be a valid ICP for some other product
 * (ghostwriter, content strategist, growth marketer, specific competitor
 * names) — those go to Stage 2.
 *
 * **Stage 2 — `judgeAuthorsWithLLM`** (Claude Haiku, ~$0.0003/call): judges
 * ambiguous bios against the caller's product context. The same bio can
 * be a competitor for one product, an ideal ICP for another — the LLM
 * decides using the product's name, description, and value prop.
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

/**
 * Universal-spam patterns. Must be bad reply targets *regardless* of what
 * product the user is growing. Never put patterns here that could plausibly
 * be an ICP for a specific product — "ghostwriter" is spam for a SaaS
 * founder but ideal ICP for an AI-ghostwriting tool, so it belongs to the
 * LLM stage, not here.
 *
 * New additions must pass this test: "is there ANY plausible product whose
 * users would want to reply under this account?" If yes, don't add it.
 */
const UNIVERSAL_SPAM_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Lead-gen / MLM funnels pitched universally (no vertical, no product, just $$).
  { pattern: /\bmake\s+(me\s+|you\s+)?\$?\d[\d,.\s]*(k|K|\/month|\/mo|\/day|\/week|\s*a\s*(month|day|week|year))\b/i, label: 'make-$X/mo funnel' },
  { pattern: /\bDM\s+(me\s+)?(to\s+)?(earn|make|learn\s+how\s+to\s+make)\b/i, label: 'DM-to-earn funnel' },
  { pattern: /\bfinancial freedom in \d+\s*(days?|weeks?|months?)\b/i, label: 'financial-freedom scam' },
  // Engagement-pod / follow-game accounts — universally dead reply targets.
  { pattern: /\b(engagement pod|follow back|follow for follow|f4f|follow4follow)\b/i, label: 'follow-game account' },
  // Crypto / web3 pump-and-shill bots.
  { pattern: /\b(airdrop|pump|100x gem|shitcoin|degen plays?)\b/i, label: 'crypto pump account' },
  { pattern: /\b(web3|nft)\s+(alpha|whale|signals?|gems?)\b/i, label: 'web3-shill account' },
  // Adult / OF promo — universally off-brand regardless of user's product.
  { pattern: /\b(onlyfans|OF)\s+(creator|model|promo)\b/i, label: 'adult-promo account' },
  // Obvious bot tells.
  { pattern: /^(🎯|💰|🚀|📈|⚡){3,}/, label: 'emoji-spam bio' },
];

/**
 * Stage-1 pre-filter: block only universal-spam bios.
 *
 * Returns `{ isCompetitor: true }` for accounts that are garbage reply
 * targets regardless of the user's product. Everything else — including
 * growth marketers, ghostwriters, content strategists, category competitors
 * — passes this stage and is judged by the LLM with product context.
 */
export const classifyAuthorBio = (bio: string | null | undefined): CompetitorMatch => {
  if (!bio || !bio.trim()) return { isCompetitor: false, reason: null };

  for (const { pattern, label } of UNIVERSAL_SPAM_PATTERNS) {
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

const JUDGE_SYSTEM = `You decide whether replying under an X/Twitter account's posts is valuable exposure for a specific product.

You will be given the product's context (name, description, value prop) and a batch of author bios. **Judge each author against THIS product** — the same bio can be a competitor for one product and an ideal target customer for another. Do not apply generic rules; reason from the product's actual category and target audience.

**Default: PASS.** Replying under most accounts is net-positive exposure. Only block when the product context gives a specific reason to.

**Block (isCompetitor=true) when BOTH are true:**
1. The author's *primary* identity (the dominant signal in their bio) is either:
   - A direct category competitor of the product, OR
   - A pure commodity-info creator whose monetization is an info-product (course, cohort, coaching package, newsletter funnel, service package) with no underlying product or business *in the same vertical the user is targeting*.
2. AND replying under their posts plausibly hurts the user — funnels audience to a competitor, or reaches people already saturated with paid offerings that overlap the user's.

**Explicitly PASS — do not block:**
- Operators who build real products/services AND *also* run a podcast, newsletter, community, or content brand. Hybrid identity is normal across every vertical.
- Fund / VC / holdco / agency operators with real portfolio work.
- Creators, coaches, or service-providers whose audience overlaps the product's ICP — even if they sell a course or run a paid community. If the user's product serves *their* audience, they're a valuable reach, not a competitor.
- Anyone whose bio you cannot unambiguously categorize against THIS product. When in doubt, pass — the community-manager / x-reply-writer has downstream safeguards for bait content.

**Key calibration:** an account described as "copywriter teaching you to write" is a competitor for a SaaS tool aimed at SaaS founders, but an ideal ICP for an AI-writing-assistant product whose users *are* writers. The verdict must flip with the product, not stay fixed. Read the product description carefully before each judgment.

Output a short reason (<= 10 words) explaining the verdict, naming the product-specific signal — e.g. "direct competitor — same category", "sells courses but not in product's vertical", "builder with real portfolio", "target ICP — audience matches product", "hybrid creator, passes".`;

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
