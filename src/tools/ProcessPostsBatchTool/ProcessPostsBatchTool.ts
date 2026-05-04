// process_posts_batch — orchestrates the full post pipeline for a
// batch of already-allocated `plan_items` rows. The Tool's `execute()`
// IS the orchestrator: parallel for-loop over plan_items, four-step
// pipeline per item (drafting-post → validate_draft → validating-draft
// → draft_post), with at most one REVISE retry that uses
// `mapSlopFingerprintToVoiceCue` to feed the writer a deterministic
// repair cue.
//
// Unlike the reply pipeline there is NO judging step — the tactical
// planner already decided this plan_item earns a post; we trust the
// allocation. That collapses the per-artifact cost ceiling to:
//
// Per-artifact cost ceiling (CLAUDE.md "Per-artifact cost ceiling"):
//   - Default 2 fork-skill calls (drafting + validating, no gating skill
//     because allocation is the gate).
//   - Max 4 fork-skill calls when REVISE fires once.
// REVISE retry max is 1; on a second REVISE the tool persists with a
// `[needs human review: ...]` flag in `whyItWorks` instead of looping.

import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition, ToolContext } from '@/core/types';
import { planItems as planItemsTbl, products } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';
import { runForkSkill } from '@/skills/run-fork-skill';
import { validateDraftTool } from '@/tools/ValidateDraftTool/ValidateDraftTool';
import { draftPostTool } from '@/tools/DraftPostTool/DraftPostTool';
import { mapSlopFingerprintToVoiceCue } from '@/lib/slop-cue-mapper';
import { createLogger } from '@/lib/logger';

const log = createLogger('tool:process_posts_batch');

export const PROCESS_POSTS_BATCH_TOOL_NAME = 'process_posts_batch';

const inputSchema = z.object({
  planItemIds: z.array(z.string()).min(1).max(10),
  voice: z.string().optional(),
  founderVoiceBlock: z.string().optional(),
});

type ProcessPostsBatchInput = z.infer<typeof inputSchema>;

interface BatchItemResult {
  planItemId: string;
  status:
    | 'persisted'
    | 'persisted_after_revise'
    | 'persisted_flagged_for_review'
    | 'rejected_mechanical'
    | 'rejected_validating'
    | 'errored';
  reason?: string;
  slopFingerprint?: string[];
}

export interface ProcessPostsBatchResult {
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

type PlanItemRow = typeof planItemsTbl.$inferSelect;

interface ProductForDraft {
  id: string;
  name: string;
  description: string;
  valueProp: string | null;
}

export const processPostsBatchTool: ToolDefinition<
  ProcessPostsBatchInput,
  ProcessPostsBatchResult
> = buildTool({
  name: PROCESS_POSTS_BATCH_TOOL_NAME,
  description:
    'Process a batch of plan_items through the full post pipeline ' +
    '(drafting-post → validate_draft → validating-draft → draft_post ' +
    'with REVISE retry, max 1). The post path has NO judging step ' +
    '(judging-thread-quality is for reply targets only). Returns a ' +
    'per-item summary in the response.\n\n' +
    'INPUT: { "planItemIds": ["uuid1",...up to 10], "voice"?: string, "founderVoiceBlock"?: string }\n' +
    'OUTPUT: { itemsScanned, draftsCreated, draftsSkipped, notes, details[] }',
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input, ctx): Promise<ProcessPostsBatchResult> {
    const { db, userId, productId } = readDomainDeps(ctx);

    const itemRows = await db
      .select()
      .from(planItemsTbl)
      .where(
        and(
          eq(planItemsTbl.userId, userId),
          inArray(planItemsTbl.id, input.planItemIds),
        ),
      );

    if (itemRows.length === 0) {
      return {
        itemsScanned: 0,
        draftsCreated: 0,
        draftsSkipped: 0,
        notes: 'no plan_items matched',
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
        `process_posts_batch: product ${productId} not found`,
      );
    }

    // Promise.allSettled rather than Promise.all so one item's
    // exception (e.g. xAI quota exhausted mid-batch) doesn't lose the
    // whole batch and orphan already-persisted drafts from earlier
    // items.
    const settled = await Promise.allSettled(
      itemRows.map((item) => processOne(item, productRow, input, ctx)),
    );
    const results: BatchItemResult[] = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      const reason =
        s.reason instanceof Error ? s.reason.message : String(s.reason);
      return {
        planItemId: itemRows[i]!.id,
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
      `process_posts_batch user=${userId} items=${itemRows.length} ` +
        `created=${draftsCreated} skipped=${itemRows.length - draftsCreated}`,
    );

    return {
      itemsScanned: itemRows.length,
      draftsCreated,
      draftsSkipped: itemRows.length - draftsCreated,
      notes,
      details: results,
    };
  },
});

async function processOne(
  item: PlanItemRow,
  product: ProductForDraft,
  input: ProcessPostsBatchInput,
  ctx: ToolContext,
): Promise<BatchItemResult> {
  // Step 1: draft
  const draft = await draftOnce(item, product, input, undefined, ctx);

  // Step 2: mechanical
  const channel = item.channel ?? '';
  const mech = await validateDraftTool.execute(
    {
      text: draft.draftBody,
      platform: channel,
      kind: 'post',
    },
    ctx,
  );
  if (mech.failures.length > 0) {
    const f = mech.failures[0]!;
    return {
      planItemId: item.id,
      status: 'rejected_mechanical',
      reason: `${f.validator}:${f.reason}`,
    };
  }

  // Step 3: validating-draft (LLM)
  const review = await validateOnce(item, product, draft, ctx);

  // Step 4: decide
  if (review.verdict === 'PASS') {
    await draftPostTool.execute(
      {
        planItemId: item.id,
        draftBody: draft.draftBody,
        whyItWorks: draft.whyItWorks,
      },
      ctx,
    );
    return {
      planItemId: item.id,
      status: 'persisted',
      slopFingerprint: review.slopFingerprint,
    };
  }

  if (review.verdict === 'REVISE') {
    const cue = mapSlopFingerprintToVoiceCue(review.slopFingerprint);
    const retry = await draftOnce(item, product, input, cue, ctx);
    const retryMech = await validateDraftTool.execute(
      {
        text: retry.draftBody,
        platform: channel,
        kind: 'post',
      },
      ctx,
    );
    if (retryMech.failures.length > 0) {
      const f = retryMech.failures[0]!;
      return {
        planItemId: item.id,
        status: 'rejected_mechanical',
        reason: `retry mech: ${f.validator}:${f.reason}`,
        slopFingerprint: review.slopFingerprint,
      };
    }
    const retryReview = await validateOnce(item, product, retry, ctx);
    if (retryReview.verdict === 'PASS') {
      await draftPostTool.execute(
        {
          planItemId: item.id,
          draftBody: retry.draftBody,
          whyItWorks: retry.whyItWorks,
        },
        ctx,
      );
      return {
        planItemId: item.id,
        status: 'persisted_after_revise',
        slopFingerprint: review.slopFingerprint,
      };
    }
    if (retryReview.verdict === 'REVISE') {
      // Per CLAUDE.md max-1-revise rule: persist with a human-review flag
      // rather than spending another fork-skill round.
      // DraftPostTool enforces whyItWorks.max(500) (Zod), so truncate the
      // base whyItWorks to leave room for the flag suffix and clamp the
      // total to 500 chars.
      const flagSuffix = ` [needs human review: ${retryReview.slopFingerprint.join(',')}]`;
      const baseLen = Math.max(0, 500 - flagSuffix.length);
      const truncatedWhy =
        retry.whyItWorks.length > baseLen
          ? retry.whyItWorks.slice(0, Math.max(0, baseLen - 1)) + '…'
          : retry.whyItWorks;
      const flaggedWhy = (truncatedWhy + flagSuffix).slice(0, 500);
      await draftPostTool.execute(
        {
          planItemId: item.id,
          draftBody: retry.draftBody,
          whyItWorks: flaggedWhy,
        },
        ctx,
      );
      return {
        planItemId: item.id,
        status: 'persisted_flagged_for_review',
        slopFingerprint: retryReview.slopFingerprint,
      };
    }
    return {
      planItemId: item.id,
      status: 'rejected_validating',
      reason: 'retry FAIL',
      slopFingerprint: retryReview.slopFingerprint,
    };
  }

  // First-pass FAIL
  return {
    planItemId: item.id,
    status: 'rejected_validating',
    reason: 'FAIL on first review',
    slopFingerprint: review.slopFingerprint,
  };
}

async function draftOnce(
  item: PlanItemRow,
  product: ProductForDraft,
  input: ProcessPostsBatchInput,
  voiceOverride: string | undefined,
  ctx: ToolContext,
): Promise<DraftSkillOutput> {
  const args = {
    planItem: {
      id: item.id,
      title: item.title,
      description: item.description ?? '',
      channel: item.channel ?? '',
      ...(item.scheduledAt
        ? { scheduledAt: item.scheduledAt.toISOString() }
        : {}),
      ...(item.params ? { params: item.params } : {}),
    },
    product: {
      name: product.name,
      description: product.description,
      ...(product.valueProp ? { valueProp: product.valueProp } : {}),
    },
    channel: item.channel ?? '',
    phase: item.phase,
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
    'drafting-post',
    JSON.stringify(args),
    undefined,
    ctx,
  );
  return result;
}

async function validateOnce(
  item: PlanItemRow,
  product: ProductForDraft,
  draft: DraftSkillOutput,
  ctx: ToolContext,
): Promise<ValidatingSkillOutput> {
  // The validating-draft skill's schema is reply-shaped (replyBody,
  // threadTitle, threadBody, subreddit). For posts we reuse the same
  // shape exactly the way content-manager's post_batch did:
  //   replyBody  ← draft.draftBody
  //   threadTitle ← planItem.title
  //   threadBody  ← planItem.description
  //   subreddit  ← channel (placeholder — 'x' or 'reddit')
  const args = {
    drafts: [
      {
        replyBody: draft.draftBody,
        threadTitle: item.title,
        threadBody: item.description ?? '',
        subreddit: item.channel ?? '',
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
