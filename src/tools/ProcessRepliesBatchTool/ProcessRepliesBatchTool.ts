// process_replies_batch — orchestrates the full reply pipeline for a
// batch of already-judged threads. The Tool's `execute()` IS the
// orchestrator: parallel for-loop over threads, four-step pipeline per
// thread (drafting-reply → validate_draft → validating-draft →
// draft_reply), with at most one REVISE retry that uses
// `mapSlopFingerprintToVoiceCue` to feed the writer a deterministic
// repair cue.
//
// Discovery already judged each thread (`threads.canMentionProduct`
// + `threads.mentionSignal` populated). Threads where both are null
// are pre-Plan-1 legacy rows and skipped without burning fork-skill
// calls.
//
// Per-artifact cost ceiling (CLAUDE.md "Per-artifact cost ceiling"):
//   - Default 2 fork-skill calls (drafting + validating, no gating skill
//     because discovery's `canMentionProduct` already gated).
//   - Max 4 fork-skill calls when REVISE fires once.
// REVISE retry max is 1; on a second REVISE the tool persists with a
// `[needs human review: ...]` flag in `whyItWorks` instead of looping.

import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition, ToolContext } from '@/core/types';
import { threads as threadsTbl, products } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';
import { runForkSkill } from '@/skills/run-fork-skill';
import { draftingReplyOutputSchema } from '@/skills/drafting-reply/schema';
import { validatingDraftOutputSchema } from '@/skills/validating-draft/schema';
import { validateDraftTool } from '@/tools/ValidateDraftTool/ValidateDraftTool';
import { draftReplyTool } from '@/tools/DraftReplyTool/DraftReplyTool';
import { mapSlopFingerprintToVoiceCue } from '@/lib/slop-cue-mapper';
import { createLogger } from '@/lib/logger';

const log = createLogger('tool:process_replies_batch');

export const PROCESS_REPLIES_BATCH_TOOL_NAME = 'process_replies_batch';

const inputSchema = z.object({
  threadIds: z.array(z.string()).min(1).max(10),
  voice: z.string().optional(),
  founderVoiceBlock: z.string().optional(),
});

type ProcessRepliesBatchInput = z.infer<typeof inputSchema>;

interface BatchItemResult {
  threadId: string;
  status:
    | 'persisted'
    | 'persisted_after_revise'
    | 'persisted_flagged_for_review'
    | 'rejected_mechanical'
    | 'rejected_validating'
    | 'skipped_legacy_unjudged'
    | 'errored';
  reason?: string;
  slopFingerprint?: string[];
}

export interface ProcessRepliesBatchResult {
  itemsScanned: number;
  draftsCreated: number;
  draftsSkipped: number;
  notes: string;
  details: BatchItemResult[];
}

type DraftSkillOutput = z.infer<typeof draftingReplyOutputSchema>;
type ValidatingSkillOutput = z.infer<typeof validatingDraftOutputSchema>;

type ThreadRow = typeof threadsTbl.$inferSelect;

interface ProductForDraft {
  id: string;
  name: string;
  description: string;
  valueProp: string | null;
}

export const processRepliesBatchTool: ToolDefinition<
  ProcessRepliesBatchInput,
  ProcessRepliesBatchResult
> = buildTool({
  name: PROCESS_REPLIES_BATCH_TOOL_NAME,
  description:
    'Process a batch of threads through the full reply pipeline (drafting-reply → ' +
    'validate_draft → validating-draft → draft_reply with REVISE retry). Discovery ' +
    'already judged each thread (canMentionProduct on the row); this tool does ' +
    'NOT re-judge. Threads with canMentionProduct=null are skipped as legacy. ' +
    'Returns a per-thread result summary in the response.\n\n' +
    'INPUT: { "threadIds": ["uuid1",...up to 10], "voice"?: string, "founderVoiceBlock"?: string }\n' +
    'OUTPUT: { itemsScanned, draftsCreated, draftsSkipped, notes, details[] }',
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input, ctx): Promise<ProcessRepliesBatchResult> {
    const { db, userId, productId } = readDomainDeps(ctx);

    const threadRows = await db
      .select()
      .from(threadsTbl)
      .where(
        and(
          eq(threadsTbl.userId, userId),
          inArray(threadsTbl.id, input.threadIds),
        ),
      );

    if (threadRows.length === 0) {
      return {
        itemsScanned: 0,
        draftsCreated: 0,
        draftsSkipped: 0,
        notes: 'no threads matched',
        details: [],
      };
    }

    const productRows = await db
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        valueProp: products.valueProp,
      })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    const productRow = productRows[0];
    if (!productRow) {
      throw new Error(
        `process_replies_batch: product ${productId} not found`,
      );
    }

    ctx.emitProgress?.(
      PROCESS_REPLIES_BATCH_TOOL_NAME,
      `Drafting replies for ${threadRows.length} thread${threadRows.length === 1 ? '' : 's'} in parallel…`,
      { threadCount: threadRows.length },
    );

    // Promise.allSettled rather than Promise.all so one thread's
    // exception (e.g. xAI quota exhausted mid-batch) doesn't lose the
    // whole batch and orphan already-persisted drafts from earlier
    // items.
    const settled = await Promise.allSettled(
      threadRows.map((thread) => processOne(thread, productRow, input, ctx)),
    );
    const results: BatchItemResult[] = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      const reason =
        s.reason instanceof Error ? s.reason.message : String(s.reason);
      return {
        threadId: threadRows[i]!.id,
        status: 'errored' as const,
        reason,
      };
    });

    const draftsCreated = results.filter(
      (r) =>
        r.status === 'persisted' ||
        r.status === 'persisted_after_revise' ||
        r.status === 'persisted_flagged_for_review',
    ).length;

    const slopCounts = new Map<string, number>();
    for (const r of results) {
      for (const fp of r.slopFingerprint ?? []) {
        slopCounts.set(fp, (slopCounts.get(fp) ?? 0) + 1);
      }
    }
    const notes =
      slopCounts.size > 0
        ? `slop fingerprints: ${[...slopCounts.entries()]
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`
        : 'no slop patterns matched';

    log.info(
      `process_replies_batch user=${userId} threads=${threadRows.length} ` +
        `created=${draftsCreated} skipped=${threadRows.length - draftsCreated}`,
    );

    const draftsSkipped = threadRows.length - draftsCreated;
    const skipBreakdown = new Map<string, number>();
    for (const r of results) {
      if (
        r.status !== 'persisted' &&
        r.status !== 'persisted_after_revise' &&
        r.status !== 'persisted_flagged_for_review'
      ) {
        skipBreakdown.set(r.status, (skipBreakdown.get(r.status) ?? 0) + 1);
      }
    }
    const skipDetail =
      skipBreakdown.size > 0
        ? ` (${[...skipBreakdown.entries()].map(([k, v]) => `${k}=${v}`).join(', ')})`
        : '';
    ctx.emitProgress?.(
      PROCESS_REPLIES_BATCH_TOOL_NAME,
      `${draftsCreated} drafted, ${draftsSkipped} skipped${skipDetail}`,
      { draftsCreated, draftsSkipped },
    );

    return {
      itemsScanned: threadRows.length,
      draftsCreated,
      draftsSkipped,
      notes,
      details: results,
    };
  },
});

async function processOne(
  thread: ThreadRow,
  product: ProductForDraft,
  input: ProcessRepliesBatchInput,
  ctx: ToolContext,
): Promise<BatchItemResult> {
  if (thread.canMentionProduct === null && thread.mentionSignal === null) {
    return {
      threadId: thread.id,
      status: 'skipped_legacy_unjudged',
      reason: 'pre-Plan-1 row',
    };
  }

  // Step 1: draft
  const draft = await draftOnce(thread, product, input, undefined, ctx);
  if (!draft) {
    return {
      threadId: thread.id,
      status: 'errored',
      reason: 'drafting-reply returned invalid output',
    };
  }

  // Step 2: mechanical
  const mech = await validateDraftTool.execute(
    {
      text: draft.draftBody,
      platform: thread.platform,
      kind: 'reply',
    },
    ctx,
  );
  if (mech.failures.length > 0) {
    const f = mech.failures[0]!;
    return {
      threadId: thread.id,
      status: 'rejected_mechanical',
      reason: `${f.validator}:${f.reason}`,
    };
  }

  // Step 3: validating-draft (LLM)
  const review = await validateOnce(thread, product, draft, ctx);
  if (!review) {
    return {
      threadId: thread.id,
      status: 'errored',
      reason: 'validating-draft returned invalid output',
    };
  }

  // Step 4: decide
  if (review.verdict === 'PASS') {
    await draftReplyTool.execute(
      {
        threadId: thread.id,
        draftBody: draft.draftBody,
        confidence: draft.confidence,
        whyItWorks: draft.whyItWorks,
      },
      ctx,
    );
    return {
      threadId: thread.id,
      status: 'persisted',
      slopFingerprint: review.slopFingerprint,
    };
  }

  if (review.verdict === 'REVISE') {
    const cue = mapSlopFingerprintToVoiceCue(review.slopFingerprint);
    const retry = await draftOnce(thread, product, input, cue, ctx);
    if (!retry) {
      return {
        threadId: thread.id,
        status: 'errored',
        reason: 'drafting-reply retry returned invalid output',
        slopFingerprint: review.slopFingerprint,
      };
    }
    const retryMech = await validateDraftTool.execute(
      {
        text: retry.draftBody,
        platform: thread.platform,
        kind: 'reply',
      },
      ctx,
    );
    if (retryMech.failures.length > 0) {
      const f = retryMech.failures[0]!;
      return {
        threadId: thread.id,
        status: 'rejected_mechanical',
        reason: `retry mech: ${f.validator}:${f.reason}`,
        slopFingerprint: review.slopFingerprint,
      };
    }
    const retryReview = await validateOnce(thread, product, retry, ctx);
    if (!retryReview) {
      return {
        threadId: thread.id,
        status: 'errored',
        reason: 'validating-draft retry returned invalid output',
        slopFingerprint: review.slopFingerprint,
      };
    }
    if (retryReview.verdict === 'PASS') {
      await draftReplyTool.execute(
        {
          threadId: thread.id,
          draftBody: retry.draftBody,
          confidence: retry.confidence,
          whyItWorks: retry.whyItWorks,
        },
        ctx,
      );
      return {
        threadId: thread.id,
        status: 'persisted_after_revise',
        slopFingerprint: review.slopFingerprint,
      };
    }
    if (retryReview.verdict === 'REVISE') {
      // Per CLAUDE.md max-1-revise rule: persist with a human-review flag
      // rather than spending another fork-skill round.
      // DraftReplyTool enforces whyItWorks.max(500) (Zod), so truncate the
      // base whyItWorks to leave room for the flag suffix and clamp the
      // total to 500 chars.
      const flagSuffix = ` [needs human review: ${retryReview.slopFingerprint.join(',')}]`;
      const baseLen = Math.max(0, 500 - flagSuffix.length);
      const truncatedWhy =
        retry.whyItWorks.length > baseLen
          ? retry.whyItWorks.slice(0, Math.max(0, baseLen - 1)) + '…'
          : retry.whyItWorks;
      const flaggedWhy = (truncatedWhy + flagSuffix).slice(0, 500);
      await draftReplyTool.execute(
        {
          threadId: thread.id,
          draftBody: retry.draftBody,
          confidence: retry.confidence,
          whyItWorks: flaggedWhy,
        },
        ctx,
      );
      return {
        threadId: thread.id,
        status: 'persisted_flagged_for_review',
        slopFingerprint: retryReview.slopFingerprint,
      };
    }
    return {
      threadId: thread.id,
      status: 'rejected_validating',
      reason: 'retry FAIL',
      slopFingerprint: retryReview.slopFingerprint,
    };
  }

  // First-pass FAIL
  return {
    threadId: thread.id,
    status: 'rejected_validating',
    reason: 'FAIL on first review',
    slopFingerprint: review.slopFingerprint,
  };
}

/**
 * Draft once via the drafting-reply skill. Passes the Zod schema through
 * to runForkSkill so runAgent synthesizes StructuredOutput with strict
 * validation; we ALSO safeParse defensively. Returns null when the fork's
 * output is malformed so callers can short-circuit to 'errored' instead
 * of crashing downstream on `draft.draftBody` undefined.
 */
async function draftOnce(
  thread: ThreadRow,
  product: ProductForDraft,
  input: ProcessRepliesBatchInput,
  voiceOverride: string | undefined,
  ctx: ToolContext,
): Promise<DraftSkillOutput | null> {
  const args = {
    thread: {
      title: thread.title,
      body: thread.body ?? '',
      author: thread.author,
      community: thread.community,
      platform: thread.platform,
    },
    product: {
      name: product.name,
      description: product.description,
      ...(product.valueProp ? { valueProp: product.valueProp } : {}),
    },
    channel: thread.platform,
    canMentionProduct: thread.canMentionProduct === true,
    ...(voiceOverride
      ? { voice: voiceOverride }
      : input.voice
        ? { voice: input.voice }
        : {}),
    ...(input.founderVoiceBlock
      ? { founderVoiceBlock: input.founderVoiceBlock }
      : {}),
  };
  const { result } = await runForkSkill(
    'drafting-reply',
    JSON.stringify(args),
    draftingReplyOutputSchema,
    ctx,
  );
  const parsed = draftingReplyOutputSchema.safeParse(result);
  if (!parsed.success) {
    log.warn(
      `drafting-reply returned invalid output for thread ${thread.id}: ${parsed.error.message}`,
    );
    return null;
  }
  return parsed.data;
}

/**
 * Validate once via the validating-draft skill. Same safeParse pattern as
 * draftOnce — runForkSkill gets the schema for StructuredOutput, then we
 * safeParse defensively. Returns null when malformed so processOne can
 * short-circuit to 'errored' instead of crashing on `review.verdict`
 * undefined access.
 */
async function validateOnce(
  thread: ThreadRow,
  product: ProductForDraft,
  draft: DraftSkillOutput,
  ctx: ToolContext,
): Promise<ValidatingSkillOutput | null> {
  const args = {
    drafts: [
      {
        replyBody: draft.draftBody,
        threadTitle: thread.title,
        threadBody: thread.body ?? '',
        subreddit: thread.community,
        productName: product.name,
        productDescription: product.description,
        confidence: draft.confidence,
        whyItWorks: draft.whyItWorks,
      },
    ],
    memoryContext: '',
  };
  const { result } = await runForkSkill(
    'validating-draft',
    JSON.stringify(args),
    validatingDraftOutputSchema,
    ctx,
  );
  const parsed = validatingDraftOutputSchema.safeParse(result);
  if (!parsed.success) {
    log.warn(
      `validating-draft returned invalid output for thread ${thread.id}: ${parsed.error.message}`,
    );
    return null;
  }
  return parsed.data;
}
