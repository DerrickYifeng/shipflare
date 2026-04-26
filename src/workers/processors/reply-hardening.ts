import { join } from 'path';
import { runAgent, createToolContext } from '@/bridge/agent-runner';
import { loadAgentFromFile } from '@/bridge/load-agent';
import { registry } from '@/tools/registry';
import { validateAiSlop } from '@/lib/reply/ai-slop-validator';
import { validateAnchorToken } from '@/lib/reply/anchor-token-validator';
import {
  runContentValidators,
  buildRepairPrompt,
  summarizeFailures,
  type ContentValidatorFailure,
} from '@/lib/content/validators';
import {
  productOpportunityJudgeOutputSchema,
  replyDrafterOutputSchema,
  type ReplyDrafterOutput,
  type ProductOpportunityJudgeOutput,
} from '@/agents/schemas';
import { createLogger } from '@/lib/logger';

const JUDGE_AGENT_PATH = join(
  process.cwd(),
  'src/tools/AgentTool/agents/product-opportunity-judge/AGENT.md',
);
const X_REPLY_WRITER_AGENT_PATH = join(
  process.cwd(),
  'src/tools/AgentTool/agents/x-reply-writer/AGENT.md',
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
  repairPrompt: string | null,
): Promise<ReplyDrafterOutput | undefined> {
  const agentConfig = loadAgentFromFile(
    X_REPLY_WRITER_AGENT_PATH,
    registry.toMap(),
  );
  const userMessage = JSON.stringify({
    tweets: [
      {
        ...input,
        canMentionProduct,
        ...(repairPrompt ? { repairPrompt } : {}),
      },
    ],
  });
  const { result } = await runAgent(
    agentConfig,
    userMessage,
    createToolContext({}),
    replyDrafterOutputSchema,
  );
  return result as ReplyDrafterOutput | undefined;
}

/**
 * Hardened reply pipeline for a single tweet.
 *
 * Stages:
 *   1. product-opportunity-judge — determines whether the product may be mentioned
 *   2. x-reply-writer — drafts the reply with canMentionProduct context
 *   3. content-validator pipeline — length, platform-leak, hallucinated-stats
 *      with up to `MAX_REGEN_ATTEMPTS` regeneration passes
 *   4. ai-slop-validator — rejects AI-sounding preambles and banned vocabulary
 *   5. anchor-token-validator — rejects replies with no concrete anchor (number/date/brand)
 *
 * This is the programmatic monitor.ts pipeline (one tweet → one draft, with
 * a code-driven regen loop). It is intentionally distinct from the
 * community-manager team-run path, which does the entire opportunity-judge +
 * draft + self-check inline in a single LLM turn using prose references.
 * Both paths produce a `drafts` row; both eventually land on the same
 * review queue. The split exists because monitor.ts is per-tweet retry
 * logic, not an agent conversation — keeping it programmatic preserves
 * the deterministic regen budget.
 *
 * Returns strategy='skip' with rejectionReasons when any stage fails. If
 * regeneration exhausts on content-validator failures, sets `needsReview`
 * so the caller can surface the draft for human approval rather than
 * silently discarding it.
 *
 * TODO: memory injection — per-tweet memoryPrompt is not appended to the
 * x-reply-writer system prompt. Known limitation of the per-tweet decomposition;
 * revisit if quality regression is observed.
 */
export async function draftReplyWithHardening(
  input: HardenedReplyInput,
): Promise<HardenedReplyOutput> {
  // Step 1: product-opportunity-judge (pre-pass).
  const judgeAgentConfig = loadAgentFromFile(
    JUDGE_AGENT_PATH,
    registry.toMap(),
  );
  const { result: judgeResult } = await runAgent(
    judgeAgentConfig,
    JSON.stringify({ tweets: [input] }),
    createToolContext({}),
    productOpportunityJudgeOutputSchema,
  );
  const judgment = (judgeResult ?? {
    allowMention: false,
    signal: 'no_fit' as const,
    confidence: 0,
    reason: 'judge returned no result',
  }) as ProductOpportunityJudgeOutput;

  const canMentionProduct = judgment.allowMention && judgment.confidence >= 0.6;

  // Step 2 + 3: draft + content-validator regen loop.
  let draft: ReplyDrafterOutput | undefined = await runReplyDrafter(
    input,
    canMentionProduct,
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
