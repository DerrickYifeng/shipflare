// draft_single_reply — drafts a single reply for a queued thread by invoking
// the draft-single-reply skill, persisting a `drafts` row, and enqueuing
// a review job. Idempotent on (userId, threadId): re-invocation returns
// the existing draft id without redrafting.
//
// Distinct from `draft_reply` (src/tools/DraftReplyTool/DraftReplyTool.ts),
// which is the *persist-only* tool used by community-manager — caller
// drafts the body in its own LLM turn, then passes the pre-drafted text.
// This skill-wrapping variant is called from the team-run loop where the
// agent delegates drafting to the draft-single-reply skill (full
// pipeline: opportunity-judge pre-pass + drafter + ai-slop validator).

import { join } from 'path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { db } from '@/lib/db';
import { drafts, products } from '@/lib/db/schema';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { enqueueReview } from '@/lib/queue';
import { readDomainDeps } from '@/tools/context-helpers';
import type { ReplyDrafterOutput } from '@/agents/schemas';

// Pre-load the skill config once per process — matches the pattern in
// reply-hardening.ts. `runSkill` takes a loaded SkillConfig, not a name.
const replyDraftSkill = loadSkill(
  join(process.cwd(), 'src/skills/draft-single-reply'),
);

export const DRAFT_SINGLE_REPLY_TOOL_NAME = 'draft_single_reply';

// Default confidence persisted on the drafts row when the underlying
// skill output doesn't include a confidence value. 0.7 matches the
// threshold the review skill uses elsewhere.
const DEFAULT_DRAFT_CONFIDENCE = 0.7;

const inputSchema = z.object({
  threadId: z.string().uuid(),
  externalId: z.string().min(1),
  body: z.string().min(1),
  author: z.string().min(1),
  platform: z.enum(['x']),
  /** Optional voice block override; otherwise loaded from product. */
  voiceBlock: z.string().nullable().optional(),
});

export interface DraftReplyResult {
  status: 'drafted' | 'skipped' | 'already_exists';
  draftId: string | null;
  body: string | null;
  rejectionReasons: string[];
  costUsd: number;
}

export const draftSingleReplyTool: ToolDefinition<
  z.infer<typeof inputSchema>,
  DraftReplyResult
> = buildTool({
  name: DRAFT_SINGLE_REPLY_TOOL_NAME,
  description:
    'Draft a single reply for a queued thread by invoking the ' +
    'draft-single-reply skill (full pipeline: opportunity-judge ' +
    'pre-pass + drafter + ai-slop validator). Persists a drafts row ' +
    'and enqueues automated review. Distinct from `draft_reply`, which ' +
    'persists a body the calling agent already drafted. ' +
    'Idempotent — re-calling with the same threadId returns the existing draft.',
  inputSchema,
  isConcurrencySafe: true,
  isReadOnly: false,
  async execute(input, ctx): Promise<DraftReplyResult> {
    const { userId, productId } = readDomainDeps(ctx);

    // Idempotency check: existing draft for this thread?
    const existing = await db
      .select({ id: drafts.id, replyBody: drafts.replyBody })
      .from(drafts)
      .where(and(eq(drafts.userId, userId), eq(drafts.threadId, input.threadId)))
      .limit(1);
    if (existing.length > 0) {
      return {
        status: 'already_exists',
        draftId: existing[0].id,
        body: existing[0].replyBody,
        rejectionReasons: [],
        costUsd: 0,
      };
    }

    const [productRow] = await db
      .select()
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    if (!productRow) throw new Error(`product ${productId} not found`);

    const skillResult = await runSkill<ReplyDrafterOutput>({
      skill: replyDraftSkill,
      input: {
        tweets: [
          {
            tweetId: input.externalId,
            tweetText: input.body,
            authorUsername: input.author,
            platform: 'x' as const,
            productName: productRow.name,
            productDescription: productRow.description,
            valueProp: productRow.valueProp ?? null,
            keywords: productRow.keywords,
            canMentionProduct: true,
            voiceBlock: input.voiceBlock ?? null,
          },
        ],
      },
    });

    const costUsd = skillResult.usage?.costUsd ?? 0;
    const firstResult = skillResult.results?.[0];
    // ReplyDrafterOutput: { replyText, confidence, strategy, whyItWorks? }
    // strategy='skip' means the drafter declined; any other value is a
    // real reply strategy. Empty replyText also counts as skip.
    const replyText = firstResult?.replyText ?? '';
    const strategy = firstResult?.strategy ?? 'skip';
    const shouldReply = strategy !== 'skip' && replyText.length > 0;

    if (!shouldReply) {
      return {
        status: 'skipped',
        draftId: null,
        body: null,
        rejectionReasons: ['drafter chose skip'],
        costUsd,
      };
    }

    const draftId = crypto.randomUUID();
    await db.insert(drafts).values({
      id: draftId,
      userId,
      threadId: input.threadId,
      status: 'pending',
      draftType: 'reply',
      replyBody: replyText,
      confidenceScore: DEFAULT_DRAFT_CONFIDENCE,
      engagementDepth: 0,
    });
    // Note: no `platform` column on drafts; no thread state mutation —
    // the existence of the drafts row is the canonical "this thread is
    // drafted" signal (see also community-manager's draft_reply tool
    // which doesn't update threads.state either).

    await enqueueReview({
      userId,
      productId,
      draftId,
    });

    return {
      status: 'drafted',
      draftId,
      body: replyText,
      rejectionReasons: [],
      costUsd,
    };
  },
});
