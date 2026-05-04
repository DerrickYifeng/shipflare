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
import { validateDraftTool } from '@/tools/ValidateDraftTool/ValidateDraftTool';
import { draftReplyTool } from '@/tools/DraftReplyTool/DraftReplyTool';
import { mapSlopFingerprintToVoiceCue } from '@/lib/slop-cue-mapper';
import { createLogger } from '@/lib/logger';

const log = createLogger('tool:process_replies_batch');

export const PROCESS_REPLIES_BATCH_TOOL_NAME = 'process_replies_batch';

const inputSchema = z.object({
  threadIds: z.array(z.string()).min(1).max(50),
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
    | 'skipped_legacy_unjudged';
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

interface DraftSkillOutput {
  draftBody: string;
  whyItWorks: string;
  confidence: number;
}

interface ValidatingSkillOutput {
  verdict: 'PASS' | 'REVISE' | 'FAIL';
  score: number;
  slopFingerprint: string[];
}

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
    'Returns a per-thread result summary; details are logged at INFO level.\n\n' +
    'INPUT: { "threadIds": ["uuid1","uuid2",...], "voice"?: string, "founderVoiceBlock"?: string }\n' +
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

    const results = await Promise.all(
      threadRows.map((thread) =>
        processOne(thread as ThreadRow, productRow, input, ctx),
      ),
    );

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

    return {
      itemsScanned: threadRows.length,
      draftsCreated,
      draftsSkipped: threadRows.length - draftsCreated,
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
      await draftReplyTool.execute(
        {
          threadId: thread.id,
          draftBody: retry.draftBody,
          confidence: retry.confidence,
          whyItWorks: `${retry.whyItWorks} [needs human review: ${retryReview.slopFingerprint.join(',')}]`,
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

async function draftOnce(
  thread: ThreadRow,
  product: ProductForDraft,
  input: ProcessRepliesBatchInput,
  voiceOverride: string | undefined,
  ctx: ToolContext,
): Promise<DraftSkillOutput> {
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
  const { result } = await runForkSkill<DraftSkillOutput>(
    'drafting-reply',
    JSON.stringify(args),
    undefined,
    ctx,
  );
  return result;
}

async function validateOnce(
  thread: ThreadRow,
  product: ProductForDraft,
  draft: DraftSkillOutput,
  ctx: ToolContext,
): Promise<ValidatingSkillOutput> {
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
  const { result } = await runForkSkill<ValidatingSkillOutput>(
    'validating-draft',
    JSON.stringify(args),
    undefined,
    ctx,
  );
  return result;
}
