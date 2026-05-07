// process_posts_batch — orchestrates the post pipeline for a batch of
// already-allocated `plan_items` rows. The Tool's `execute()` IS the
// orchestrator: parallel for-loop over plan_items, three-step pipeline
// per item (drafting-post → validate_draft (mechanical) → draft_post
// persistence). The LLM-validation fork was intentionally dropped —
// empirical recall < precision when validating-draft was gating, so the
// drafting skill's prompt now performs an in-fork self-audit and the
// founder reviews surviving drafts in /today.
//
// Unlike the reply pipeline there is NO judging step — the tactical
// planner already decided this plan_item earns a post; we trust the
// allocation. That collapses the per-artifact cost ceiling to:
//
// Per-artifact cost ceiling (CLAUDE.md "Per-artifact cost ceiling"):
//   - 1 fork-skill call (drafting only). Mechanical `validate_draft`
//     runs as a deterministic tool (no LLM cost).

import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition, ToolContext } from '@/core/types';
import { planItems as planItemsTbl, products } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';
import { runForkSkill } from '@/skills/run-fork-skill';
import { draftingPostOutputSchema } from '@/skills/drafting-post/schema';
import { validateDraftTool } from '@/tools/ValidateDraftTool/ValidateDraftTool';
import { draftPostTool } from '@/tools/DraftPostTool/DraftPostTool';
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
    | 'rejected_mechanical'
    | 'skipped_subreddit_rule_conflict'
    | 'errored';
  reason?: string;
}

export interface ProcessPostsBatchResult {
  itemsScanned: number;
  draftsCreated: number;
  draftsSkipped: number;
  notes: string;
  details: BatchItemResult[];
}

type DraftSkillOutput = z.infer<typeof draftingPostOutputSchema>;

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
    'Process a batch of plan_items through the post pipeline ' +
    '(drafting-post → validate_draft → draft_post). The post path has NO ' +
    'judging step (judging-thread-quality is for reply targets only) and ' +
    'NO LLM-validation fork — the drafting skill self-audits in-fork. ' +
    'Returns a per-item summary in the response.\n\n' +
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

    ctx.emitProgress?.(
      PROCESS_POSTS_BATCH_TOOL_NAME,
      `Drafting posts for ${itemRows.length} plan_item${itemRows.length === 1 ? '' : 's'} in parallel…`,
      { planItemCount: itemRows.length },
    );

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

    const draftsCreated = results.filter((r) => r.status === 'persisted').length;

    log.info(
      `process_posts_batch user=${userId} items=${itemRows.length} ` +
        `created=${draftsCreated} skipped=${itemRows.length - draftsCreated}`,
    );

    const draftsSkipped = itemRows.length - draftsCreated;
    const skipBreakdown = new Map<string, number>();
    for (const r of results) {
      if (r.status !== 'persisted') {
        skipBreakdown.set(r.status, (skipBreakdown.get(r.status) ?? 0) + 1);
      }
    }
    const skipDetail =
      skipBreakdown.size > 0
        ? ` (${[...skipBreakdown.entries()].map(([k, v]) => `${k}=${v}`).join(', ')})`
        : '';
    const notes =
      skipBreakdown.size > 0
        ? `breakdown: ${[...skipBreakdown.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`
        : 'all drafts persisted';
    ctx.emitProgress?.(
      PROCESS_POSTS_BATCH_TOOL_NAME,
      `${draftsCreated} drafted, ${draftsSkipped} skipped${skipDetail}`,
      { draftsCreated, draftsSkipped },
    );

    return {
      itemsScanned: itemRows.length,
      draftsCreated,
      draftsSkipped,
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
  // Step 1: draft (only fork-skill call — drafting-post self-audits)
  const draft = await draftOnce(item, product, input, ctx);
  if (!draft) {
    return {
      planItemId: item.id,
      status: 'errored',
      reason: 'drafting-post returned invalid output',
    };
  }

  // Safe-skip: drafting skill flagged a subreddit rule conflict (Reddit
  // self-promo / no-AI / no-founders rule). The skill returns
  // `{ draftBody: '', flagged: true, flagReason }` — we MUST short-circuit
  // BEFORE validate_draft, which would otherwise reject the empty body
  // with a cryptic Zod error. The founder will see the skip in /today.
  if (draft.flagged === true) {
    return {
      planItemId: item.id,
      status: 'skipped_subreddit_rule_conflict',
      reason: draft.flagReason ?? 'subreddit rule conflict',
    };
  }

  // Step 2: mechanical validate (deterministic — length, banned vocab regex)
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

  // Step 3: persist
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
  };
}

/**
 * Draft once via the drafting-post skill. Passes the Zod schema through to
 * runForkSkill (so runAgent synthesizes StructuredOutput with strict
 * validation) and ALSO safeParses defensively. Returns null when the
 * fork's output is malformed so callers short-circuit to 'errored'
 * instead of crashing on `draft.draftBody` undefined access.
 */
async function draftOnce(
  item: PlanItemRow,
  product: ProductForDraft,
  input: ProcessPostsBatchInput,
  ctx: ToolContext,
): Promise<DraftSkillOutput | null> {
  // Plumb the target subreddit (Reddit-only) up to the top-level
  // `targetSubreddit` slot the drafting-post skill schema expects, so
  // `get_subreddit_rules` runs against the real subreddit. The planner
  // stores it on `params.subreddit` (per `reddit-post-voice.md` and the
  // legacy free-form params shape); we also accept `params.targetSubreddit`
  // as an alias to match the drafting-post schema field name.
  const params = (item.params ?? {}) as {
    subreddit?: unknown;
    targetSubreddit?: unknown;
  };
  const rawSubreddit =
    typeof params.subreddit === 'string'
      ? params.subreddit
      : typeof params.targetSubreddit === 'string'
        ? params.targetSubreddit
        : undefined;
  const targetSubreddit =
    item.channel === 'reddit' && rawSubreddit && rawSubreddit.length > 0
      ? rawSubreddit
      : undefined;

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
    ...(targetSubreddit ? { targetSubreddit } : {}),
    ...(input.voice ? { voice: input.voice } : {}),
    ...(input.founderVoiceBlock
      ? { founderVoiceBlock: input.founderVoiceBlock }
      : {}),
  };
  const { result } = await runForkSkill(
    'drafting-post',
    JSON.stringify(args),
    draftingPostOutputSchema,
    ctx,
  );
  const parsed = draftingPostOutputSchema.safeParse(result);
  if (!parsed.success) {
    log.warn(
      `drafting-post returned invalid output for plan_item ${item.id}: ${parsed.error.message}`,
    );
    return null;
  }
  return parsed.data;
}
