// draft_post — generate an X (or future-platform) post body for one
// plan_items row and persist it.
//
// Called by: x-writer (and, in Phase E Day 2, reddit-writer via the same
// tool with a different channel). The caller is spawned as a subagent;
// its Task prompt carries the `planItemId`. The tool:
//
//   1. Reads the plan_items row (scoped to userId + productId).
//   2. Pulls product context (name, description, valueProp) for the
//      draft prompt.
//   3. Calls `sideQuery` with a channel-specific system prompt + user
//      brief. Returns a single body string (tweet or thread-joined text).
//   4. UPDATEs `plan_items.output.draft_body` + state='drafted'.
//
// The channel is derived from plan_items.channel; callers cannot override.
// This keeps the tool honest: x-writer spawned against a reddit plan_item
// would generate reddit-shaped copy, not X-shaped — surfaces mis-routing
// as content mismatch rather than silent wrong-platform posts.

import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { planItems, products } from '@/lib/db/schema';
import { readDomainDeps, tryGet } from '@/tools/context-helpers';
import {
  sideQuery as defaultSideQuery,
  type SideQueryOptions,
} from '@/core/api-client';
import type Anthropic from '@anthropic-ai/sdk';

export const DRAFT_POST_TOOL_NAME = 'draft_post';

// Per-channel system prompts. Kept short — the agent's own
// system prompt (AGENT.md + inlined references) carries the bulk of the
// platform guidance. This prompt is just enough to orient sideQuery's
// isolated Anthropic call, which does NOT see the caller's system text.
const X_SYSTEM_PROMPT =
  'You are a staff writer for an indie product\'s X (Twitter) presence. ' +
  'Draft ONE original post or short thread based on the brief. Respect: ' +
  '280 chars per tweet (hard cap), #buildinpublic hashtag, first-person ' +
  'voice, no corporate tone, no emoji spam (max 1-2 per tweet), no links ' +
  'in tweet body (put links in first-reply if needed). Threads are 3-7 ' +
  'tweets joined by a double newline in your output. A single tweet is ' +
  'one body string. Do NOT mention reddit, subreddits, karma, or upvotes ' +
  'without an explicit contrast marker (unlike/vs/instead of). Numeric ' +
  'claims require a citation in the same sentence — if you don\'t have ' +
  'one, rewrite qualitatively. Return ONLY the draft body, no preamble, ' +
  'no JSON, no markdown fences.';

const REDDIT_SYSTEM_PROMPT =
  'You are a staff writer for an indie product\'s Reddit presence. ' +
  'Draft ONE original post based on the brief. Respect: max 40,000 chars, ' +
  'honest non-promotional tone, no self-promotion in the opening, provide ' +
  'value before any product mention. Do NOT mention X/Twitter or tweets ' +
  'without an explicit contrast marker. Numeric claims require a citation ' +
  'in the same sentence. Return ONLY the post body (no title prefix, no ' +
  'JSON, no markdown fences).';

const CONTEXT_SCHEMA = z
  .object({
    theme: z.string().optional(),
    angle: z.string().optional(),
    pillar: z.string().optional(),
    voice: z.string().optional(),
  })
  .partial()
  .strict();

export const draftPostInputSchema = z
  .object({
    planItemId: z.string().min(1, 'planItemId is required'),
    context: CONTEXT_SCHEMA.optional(),
  })
  .strict();

export type DraftPostInput = z.infer<typeof draftPostInputSchema>;

export interface DraftPostResult {
  planItemId: string;
  draft_body: string;
  channel: string;
}

interface DraftBriefInputs {
  productName: string;
  productDescription: string;
  valueProp: string | null;
  itemTitle: string;
  itemDescription: string | null;
  itemParams: Record<string, unknown>;
  context: DraftPostInput['context'];
}

function buildUserBrief(inputs: DraftBriefInputs): string {
  const lines: string[] = [];
  lines.push(`Product: ${inputs.productName}`);
  lines.push(`Description: ${inputs.productDescription}`);
  if (inputs.valueProp) lines.push(`Value prop: ${inputs.valueProp}`);
  lines.push('');
  lines.push(`Plan item: ${inputs.itemTitle}`);
  if (inputs.itemDescription) {
    lines.push(`Item description: ${inputs.itemDescription}`);
  }
  if (inputs.itemParams && Object.keys(inputs.itemParams).length > 0) {
    lines.push(`Item params: ${JSON.stringify(inputs.itemParams)}`);
  }
  if (inputs.context) {
    const ctxPairs = Object.entries(inputs.context).filter(
      ([, v]) => v !== undefined && v !== '',
    );
    if (ctxPairs.length > 0) {
      lines.push('');
      lines.push('Caller context:');
      for (const [k, v] of ctxPairs) lines.push(`- ${k}: ${v}`);
    }
  }
  lines.push('');
  lines.push('Draft the post body now. Output only the body text.');
  return lines.join('\n');
}

/** Extract the first text block from a sideQuery response. */
function firstTextBlock(response: Anthropic.Messages.Message): string | null {
  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') return null;
  return block.text.trim();
}

type SideQueryFn = (opts: SideQueryOptions) => Promise<Anthropic.Messages.Message>;

export const draftPostTool: ToolDefinition<DraftPostInput, DraftPostResult> =
  buildTool({
    name: DRAFT_POST_TOOL_NAME,
    description:
      'Generate the body text for a single content_post plan_item and ' +
      'persist it to plan_items.output.draft_body. Pass the plan_item id ' +
      'and optional context hints (theme, angle, pillar, voice). The ' +
      'channel is read from the plan_items row — do NOT pass it. Safe to ' +
      'call in parallel for distinct plan_item ids.',
    inputSchema: draftPostInputSchema,
    isConcurrencySafe: true,
    isReadOnly: false,
    async execute(input, ctx): Promise<DraftPostResult> {
      const { db, userId, productId } = readDomainDeps(ctx);

      // 1. Load the plan_item, scoped to (userId, productId).
      const itemRows = await db
        .select({
          id: planItems.id,
          userId: planItems.userId,
          productId: planItems.productId,
          channel: planItems.channel,
          kind: planItems.kind,
          title: planItems.title,
          description: planItems.description,
          params: planItems.params,
          output: planItems.output,
        })
        .from(planItems)
        .where(eq(planItems.id, input.planItemId))
        .limit(1);
      const item = itemRows[0];
      if (!item) {
        throw new Error(
          `draft_post: plan_item ${input.planItemId} not found`,
        );
      }
      if (item.userId !== userId || item.productId !== productId) {
        throw new Error(
          `draft_post: plan_item ${input.planItemId} is not owned by the ` +
            `current (user, product)`,
        );
      }
      if (item.kind !== 'content_post') {
        throw new Error(
          `draft_post: plan_item ${input.planItemId} has kind="${item.kind}", ` +
            `expected "content_post"`,
        );
      }
      const channel = item.channel;
      if (!channel) {
        throw new Error(
          `draft_post: plan_item ${input.planItemId} has no channel set; ` +
            `cannot pick a platform-specific drafting prompt`,
        );
      }

      const systemPrompt =
        channel === 'x'
          ? X_SYSTEM_PROMPT
          : channel === 'reddit'
            ? REDDIT_SYSTEM_PROMPT
            : null;
      if (systemPrompt === null) {
        throw new Error(
          `draft_post: unsupported channel "${channel}" — only x and ` +
            `reddit are wired for drafting. Add a system prompt to ` +
            `src/tools/DraftingTools/Post.ts to extend.`,
        );
      }

      // 2. Product context.
      const productRows = await db
        .select({
          name: products.name,
          description: products.description,
          valueProp: products.valueProp,
        })
        .from(products)
        .where(and(eq(products.id, productId), eq(products.userId, userId)))
        .limit(1);
      const product = productRows[0];
      if (!product) {
        throw new Error(
          `draft_post: product ${productId} not found for user ${userId}`,
        );
      }

      // 3. sideQuery. Callers in tests inject a stub via ctx.get('sideQuery').
      const sideQueryFn = tryGet<SideQueryFn>(ctx, 'sideQuery') ?? defaultSideQuery;

      const userBrief = buildUserBrief({
        productName: product.name,
        productDescription: product.description,
        valueProp: product.valueProp,
        itemTitle: item.title,
        itemDescription: item.description,
        itemParams: (item.params as Record<string, unknown>) ?? {},
        context: input.context,
      });

      const response = await sideQueryFn({
        model: 'claude-haiku-4-5-20251001',
        system: systemPrompt,
        messages: [{ role: 'user', content: userBrief }],
        maxTokens: 2048,
        signal: ctx.abortSignal,
      });

      const draftBody = firstTextBlock(response);
      if (!draftBody) {
        throw new Error(
          `draft_post: sideQuery returned no text block for plan_item ` +
            `${input.planItemId}`,
        );
      }

      // 4. Persist to plan_items.output.draft_body.
      // Schema carries a single jsonb `output` column (no dedicated
      // draft_body text column). We merge — keeping any prior keys
      // (e.g. `confidence`, `whyItWorks` from future validators) —
      // rather than overwriting, so downstream tools can accrete on
      // the same row.
      const prevOutput =
        (item.output as Record<string, unknown> | null | undefined) ?? {};
      const nextOutput = { ...prevOutput, draft_body: draftBody, channel };

      await db
        .update(planItems)
        .set({
          output: nextOutput,
          state: 'drafted',
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(planItems.id, input.planItemId),
            eq(planItems.userId, userId),
            eq(planItems.productId, productId),
          ),
        );

      return {
        planItemId: input.planItemId,
        draft_body: draftBody,
        channel,
      };
    },
  });
