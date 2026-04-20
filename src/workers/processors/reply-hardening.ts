import { join } from 'path';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { validateAiSlop } from '@/lib/reply/ai-slop-validator';
import { validateAnchorToken } from '@/lib/reply/anchor-token-validator';
import {
  runContentValidators,
  buildRepairPrompt,
  summarizeFailures,
  type ContentValidatorFailure,
} from '@/lib/content/validators';
import type { ReplyDrafterOutput, ProductOpportunityJudgeOutput } from '@/agents/schemas';
import { loadVoiceBlockForUser } from '@/lib/voice/inject';
import { createLogger } from '@/lib/logger';

// Pre-load both skills at module init (same pattern as monitor.ts for replyDraftSkill)
const judgeSkill = loadSkill(
  join(process.cwd(), 'src/skills/product-opportunity-judge'),
);
const replyDraftSkill = loadSkill(
  join(process.cwd(), 'src/skills/draft-single-reply'),
);

const log = createLogger('worker:reply-hardening');

const MAX_REGEN_ATTEMPTS = 2;
/**
 * Every reply this pipeline produces ships against X, so the content
 * validators use `platform: 'x'` and `kind: 'reply'` here.
 */
const REPLY_PLATFORM = 'x';
const REPLY_KIND = 'reply' as const;

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
  /**
   * When `true`, the draft left the pipeline because regeneration exhausted
   * the retry budget on content-validator failures. The caller (monitor.ts)
   * should route it to human review rather than auto-discarding — the copy
   * is close enough that a small edit will usually ship it.
   */
  needsReview?: boolean;
  /** Structured validator failure payloads for `reviewJson`-style storage. */
  contentValidatorFailures?: ContentValidatorFailure[];
}

async function runReplyDrafter(
  input: HardenedReplyInput,
  canMentionProduct: boolean,
  voiceBlock: string | null,
  repairPrompt: string | null,
): Promise<ReplyDrafterOutput | undefined> {
  const drafterRes = await runSkill<ReplyDrafterOutput>({
    skill: replyDraftSkill,
    input: {
      tweets: [
        {
          ...input,
          canMentionProduct,
          voiceBlock,
          ...(repairPrompt ? { repairPrompt } : {}),
        },
      ],
    },
  });
  return drafterRes.results[0] as ReplyDrafterOutput | undefined;
}

/**
 * Hardened reply pipeline for a single tweet.
 *
 * Stages:
 *   1. product-opportunity-judge — determines whether the product may be mentioned
 *   2. draft-single-reply (reply-drafter) — drafts the reply with canMentionProduct context
 *   3. content-validator pipeline — length, platform-leak, hallucinated-stats
 *      with up to `MAX_REGEN_ATTEMPTS` regeneration passes
 *   4. ai-slop-validator — rejects AI-sounding preambles and banned vocabulary
 *   5. anchor-token-validator — rejects replies with no concrete anchor (number/date/brand)
 *
 * Returns strategy='skip' with rejectionReasons when any stage fails. If
 * regeneration exhausts on content-validator failures, sets `needsReview`
 * so the caller can surface the draft for human approval rather than
 * silently discarding it.
 *
 * TODO: memory injection — the draft-single-reply skill receives no memoryPrompt here.
 * The caller (monitor.ts) used to inject memoryPrompt at the batch runSkill level;
 * that injection now happens inside the skill's own mechanism via skill-runner
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
    ? await loadVoiceBlockForUser(input.userId, REPLY_PLATFORM)
    : null;

  // Step 2 + 3: draft + content-validator regen loop.
  let draft: ReplyDrafterOutput | undefined = await runReplyDrafter(
    input,
    canMentionProduct,
    voiceBlock,
    null,
  );
  let lastFailures: ContentValidatorFailure[] = [];

  for (let attempt = 0; attempt <= MAX_REGEN_ATTEMPTS; attempt += 1) {
    if (!draft || draft.strategy === 'skip') break;

    const validation = runContentValidators({
      text: draft.replyText,
      platform: REPLY_PLATFORM,
      kind: REPLY_KIND,
    });
    if (validation.ok) {
      lastFailures = [];
      break;
    }

    lastFailures = validation.failures;
    log.warn(
      `reply content validators failed (attempt ${attempt + 1}/${MAX_REGEN_ATTEMPTS + 1}): ` +
        summarizeFailures(validation.failures),
      { tweetId: input.tweetId },
    );

    if (attempt === MAX_REGEN_ATTEMPTS) break;

    const repairPrompt = buildRepairPrompt(validation.failures, REPLY_PLATFORM);
    draft = await runReplyDrafter(
      input,
      canMentionProduct,
      voiceBlock,
      repairPrompt,
    );
  }

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

  // Content validators exhausted — surface for human review instead of dropping.
  if (lastFailures.length > 0) {
    const summary = summarizeFailures(lastFailures);
    log.info(
      `reply needs review after ${MAX_REGEN_ATTEMPTS} regen attempt(s): ${summary}`,
      { tweetId: input.tweetId },
    );
    return {
      replyText: draft.replyText,
      confidence: draft.confidence,
      strategy: 'skip',
      whyItWorks: draft.whyItWorks,
      canMentionProduct,
      productOpportunitySignal: judgment.signal,
      rejectionReasons: lastFailures.map((f) => `content_validator:${f.validator}`),
      needsReview: true,
      contentValidatorFailures: lastFailures,
    };
  }

  // Step 4 + 5: AI-slop + anchor-token validators (existing behavior).
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
