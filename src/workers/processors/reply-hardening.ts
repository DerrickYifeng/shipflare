import { join } from 'path';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { validateAiSlop } from '@/lib/reply/ai-slop-validator';
import { validateAnchorToken } from '@/lib/reply/anchor-token-validator';
import type { ReplyDrafterOutput, ProductOpportunityJudgeOutput } from '@/agents/schemas';
import { loadVoiceBlockForUser } from '@/lib/voice/inject';

// Pre-load both skills at module init (same pattern as monitor.ts for replyScanSkill)
const judgeSkill = loadSkill(
  join(process.cwd(), 'src/skills/product-opportunity-judge'),
);
const replyScanSkill = loadSkill(
  join(process.cwd(), 'src/skills/reply-scan'),
);

export interface HardenedReplyInput {
  tweetId: string;
  tweetText: string;
  authorUsername: string;
  quotedText?: string;
  quotedAuthorUsername?: string;
  quotedTweetId?: string;
  product: { name: string; description: string; valueProp: string; keywords: string[] };
  userId?: string;
}

export interface HardenedReplyOutput extends ReplyDrafterOutput {
  canMentionProduct: boolean;
  productOpportunitySignal: ProductOpportunityJudgeOutput['signal'];
  rejectionReasons: string[];
}

/**
 * Hardened reply pipeline for a single tweet.
 *
 * Stages:
 *   1. product-opportunity-judge — determines whether the product may be mentioned
 *   2. reply-scan (reply-drafter) — drafts the reply with canMentionProduct context
 *   3. ai-slop-validator — rejects AI-sounding preambles and banned vocabulary
 *   4. anchor-token-validator — rejects replies with no concrete anchor (number/date/brand)
 *
 * Returns strategy='skip' with rejectionReasons when any stage fails.
 *
 * TODO: memory injection — the reply-scan skill receives no memoryPrompt here.
 * The caller (monitor.ts) used to inject memoryPrompt at the batch runSkill level;
 * that injection now happens inside reply-scan's own skill mechanism via skill-runner
 * when deps are provided. Per-tweet memory enrichment is a known limitation of this
 * per-tweet decomposition; revisit if quality regression is observed.
 */
export async function draftReplyWithHardening(
  input: HardenedReplyInput,
): Promise<HardenedReplyOutput> {
  // Step 1: product-opportunity-judge (pre-pass).
  const judgeRes = await runSkill<ProductOpportunityJudgeOutput>({
    skill: judgeSkill,
    input: { tweets: [input] },
  });

  const judgment = (judgeRes.results[0] ?? {
    allowMention: false,
    signal: 'no_fit' as const,
    confidence: 0,
    reason: 'judge returned no result',
  }) as ProductOpportunityJudgeOutput;

  const canMentionProduct = judgment.allowMention && judgment.confidence >= 0.6;

  const voiceBlock = input.userId
    ? await loadVoiceBlockForUser(input.userId, 'x')
    : null;

  // Step 2: reply-drafter with canMentionProduct injected into the tweet context.
  const drafterRes = await runSkill<ReplyDrafterOutput>({
    skill: replyScanSkill,
    input: { tweets: [{ ...input, canMentionProduct, voiceBlock }] },
  });

  const draft = drafterRes.results[0] as ReplyDrafterOutput | undefined;

  if (!draft || draft.strategy === 'skip') {
    return {
      replyText: draft?.replyText ?? '',
      confidence: draft?.confidence ?? 0,
      strategy: 'skip',
      whyItWorks: draft?.whyItWorks,
      canMentionProduct,
      productOpportunitySignal: judgment.signal,
      rejectionReasons: draft ? [] : ['drafter_empty'],
    };
  }

  // Step 3: validators.
  const slop = validateAiSlop(draft.replyText);
  const anchor = validateAnchorToken(draft.replyText);

  const rejectionReasons: string[] = [
    ...slop.violations,
    ...(anchor.pass ? [] : ['no_anchor_token']),
  ];

  if (rejectionReasons.length > 0) {
    return {
      replyText: draft.replyText,
      confidence: draft.confidence,
      strategy: 'skip',
      whyItWorks: draft.whyItWorks,
      canMentionProduct,
      productOpportunitySignal: judgment.signal,
      rejectionReasons,
    };
  }

  return {
    ...draft,
    canMentionProduct,
    productOpportunitySignal: judgment.signal,
    rejectionReasons: [],
  };
}
