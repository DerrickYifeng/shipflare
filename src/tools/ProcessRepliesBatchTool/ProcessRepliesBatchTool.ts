// process_replies_batch — orchestrates the reply pipeline for a batch
// of already-judged threads. The Tool's `execute()` IS the
// orchestrator: parallel for-loop over threads, three-step pipeline per
// thread (drafting-reply → validate_draft (mechanical) → draft_reply
// persistence). The LLM-validation fork was intentionally dropped —
// empirical recall < precision when validating-draft was gating, so the
// drafting skill's prompt now performs an in-fork self-audit and the
// founder reviews surviving drafts in /today.
//
// Discovery already judged each thread (`threads.canMentionProduct`
// + `threads.mentionSignal` populated). Threads where both are null
// are pre-Plan-1 legacy rows and skipped without burning fork-skill
// calls.
//
// Per-artifact cost ceiling (CLAUDE.md "Per-artifact cost ceiling"):
//   - 1 fork-skill call (drafting only). Mechanical `validate_draft`
//     runs as a deterministic tool (no LLM cost).

import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition, ToolContext } from '@/core/types';
import { threads as threadsTbl, products } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';
import { runForkSkill } from '@/skills/run-fork-skill';
import { draftingReplyOutputSchema } from '@/skills/drafting-reply/schema';
import { validateDraftTool } from '@/tools/ValidateDraftTool/ValidateDraftTool';
import { draftReplyTool } from '@/tools/DraftReplyTool/DraftReplyTool';
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
    | 'rejected_mechanical'
    | 'skipped_legacy_unjudged'
    | 'skipped_author_throttled'
    | 'errored';
  reason?: string;
}

export interface ProcessRepliesBatchResult {
  itemsScanned: number;
  draftsCreated: number;
  draftsSkipped: number;
  notes: string;
  details: BatchItemResult[];
}

type DraftSkillOutput = z.infer<typeof draftingReplyOutputSchema>;

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
    'Process a batch of threads through the reply pipeline (drafting-reply → ' +
    'validate_draft → draft_reply). Discovery already judged each thread ' +
    '(canMentionProduct on the row); this tool does NOT re-judge. Threads ' +
    'with canMentionProduct=null are skipped as legacy. The drafting skill ' +
    'self-audits in-fork; no second LLM-validation fork. Returns a per-thread ' +
    'result summary in the response.\n\n' +
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

    const draftsCreated = results.filter((r) => r.status === 'persisted').length;

    log.info(
      `process_replies_batch user=${userId} threads=${threadRows.length} ` +
        `created=${draftsCreated} skipped=${threadRows.length - draftsCreated}`,
    );

    const draftsSkipped = threadRows.length - draftsCreated;
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

  // Step 1: draft (only fork-skill call — drafting-reply self-audits)
  const draft = await draftOnce(thread, product, input, ctx);
  if (!draft) {
    return {
      threadId: thread.id,
      status: 'errored',
      reason: 'drafting-reply returned invalid output',
    };
  }

  // Step 2: mechanical validate (deterministic — length, banned vocab regex)
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

  // Step 3: persist (or skip if last-mile throttle trips)
  const persisted = await draftReplyTool.execute(
    {
      threadId: thread.id,
      draftBody: draft.draftBody,
      confidence: draft.confidence,
      whyItWorks: draft.whyItWorks,
    },
    ctx,
  );
  if (persisted.skipped) {
    return {
      threadId: thread.id,
      status: 'skipped_author_throttled',
      reason: `author=${persisted.author ?? 'unknown'}`,
    };
  }
  return {
    threadId: thread.id,
    status: 'persisted',
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
  ctx: ToolContext,
): Promise<DraftSkillOutput | null> {
  const args = {
    thread: {
      title: thread.title,
      body: thread.body ?? '',
      author: thread.author,
      authorBio: thread.authorBio,
      authorFollowers: thread.authorFollowers,
      quotedText: thread.quotedText,
      quotedAuthor: thread.quotedAuthor,
      inReplyToText: thread.inReplyToText,
      inReplyToAuthor: thread.inReplyToAuthor,
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
    ...(input.voice ? { voice: input.voice } : {}),
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
