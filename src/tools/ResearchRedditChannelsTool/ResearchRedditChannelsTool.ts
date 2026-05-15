/**
 * research_reddit_channels — discover the top-3 subreddits where the
 * product's ICP gathers, persist them to `product_reddit_channels`,
 * and return them inline so the caller can use them immediately.
 *
 * Used by the kickoff coordinator when no auto Reddit channels exist
 * yet for a product: the coordinator spawns a research subagent in
 * parallel with reply / X-post drafting, then once the research
 * returns it adds Reddit content_post plan_items with the freshly
 * discovered subreddits.
 *
 * Internally calls the same `runRedditChannelResearch` helper the
 * `reddit-channel-research` BullMQ worker uses, so the synchronous
 * (tool) path and the queued (worker) path share one code path.
 *
 * Idempotent: when `force=false` (the default), returns the existing
 * subreddit list without calling xAI / Reddit if at least one auto
 * row already exists. Manual rows are never touched on either path.
 */

import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import { runRedditChannelResearch } from '@/workers/processors/reddit-channel-research';
import { readDomainDeps } from '@/tools/context-helpers';

export const RESEARCH_REDDIT_CHANNELS_TOOL_NAME = 'research_reddit_channels';

const inputSchema = z
  .object({
    /** If true, wipe prior auto rows and re-research. Defaults to
     *  false (idempotent — returns existing rows if any). */
    force: z.boolean().default(false),
  })
  .strict();

export interface ResearchRedditChannelsResult {
  /** Active (not disabled) subreddits ordered by rank ASC. Either the
   *  freshly-written top-3 (after a successful run) or the existing
   *  list (when idempotency short-circuits the skill call). */
  subreddits: Array<{
    subreddit: string;
    rank: number;
    fitScore: number | null;
  }>;
  /** Number of new auto rows written this run. 0 means idempotency
   *  no-op (rows already existed and force=false) OR the skill
   *  returned no candidates. */
  written: number;
}

export const researchRedditChannelsTool = buildTool({
  name: RESEARCH_REDDIT_CHANNELS_TOOL_NAME,
  description:
    "Research the top-3 subreddits where the product's ICP gathers. " +
    'Calls xAI Grok web_search restricted to reddit.com, enriches via ' +
    'Reddit public JSON API, and persists to product_reddit_channels. ' +
    'Idempotent: by default skips when at least one auto row exists. ' +
    'Pass force=true to overwrite prior autos (manual rows preserved). ' +
    'Returns the active subreddit list so the caller can immediately ' +
    'use it for plan_item params.',
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input, ctx): Promise<ResearchRedditChannelsResult> {
    const { userId, productId } = readDomainDeps(ctx);
    return runRedditChannelResearch(
      { userId, productId, force: input.force },
      ctx,
    );
  },
});
