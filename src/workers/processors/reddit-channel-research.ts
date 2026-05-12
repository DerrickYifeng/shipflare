/**
 * reddit-channel-research processor.
 *
 * Runs the `researching-reddit-channels` fork-skill, enriches the top-3
 * candidates with deterministic data from Reddit's public JSON API
 * (`fetchSubredditAbout` + `fetchSubredditActivity`), and persists them
 * to `product_reddit_channels` with `source='auto'`.
 *
 * Idempotency: by default, the processor skips when at least one auto
 * row exists for the product. `force=true` (re-research from settings)
 * wipes prior autos in the same transaction and re-writes the new
 * top-3. Manual rows (`source='manual'`) are never touched.
 *
 * Cost: one xAI call per run (~$0.05, 10-20s) + a few unauthenticated
 * Reddit /about + /new.json fetches. The enrichment helpers swallow
 * their own errors so one bad subreddit (404, rate-limited, malformed
 * payload) does not kill the batch.
 *
 * Architecture: the core research logic lives in
 * `runRedditChannelResearch`, exported so a synchronous caller (the
 * `research_reddit_channels` tool, used by the kickoff coordinator
 * when no auto rows exist yet) can reuse the exact same code path
 * without going through BullMQ. The BullMQ worker
 * (`processRedditChannelResearch`) is a thin wrapper around it.
 */
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  productRedditChannels,
  products,
  type NewProductRedditChannel,
} from '@/lib/db/schema';
import { runForkSkill } from '@/skills/run-fork-skill';
import {
  researchingRedditChannelsOutputSchema,
  type ResearchingRedditChannelsOutput,
} from '@/skills/researching-reddit-channels/schema';
import {
  fetchSubredditAbout,
  fetchSubredditActivity,
} from '@/lib/reddit-channel-enrichment';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { Logger } from '@/lib/logger';
import { listActiveSubreddits } from '@/lib/db/repositories/product-reddit-channels';
import type { RedditChannelResearchJobData } from '@/lib/queue';
import type { ToolContext } from '@/core/types';

const baseLog = createLogger('worker:reddit-channel-research');

/** Top-K winners persisted to product_reddit_channels per run. */
const TOP_K = 3;
/** Candidate count requested from the research skill (skill clamps 3..12). */
const CANDIDATE_COUNT = 6;

export interface RunRedditChannelResearchArgs {
  userId: string;
  productId: string;
  /** When true, wipe prior auto rows and re-research. Default false. */
  force?: boolean;
}

export interface RunRedditChannelResearchResult {
  /** Active (not disabled) subreddits ordered by rank ASC. Either the
   *  freshly-written list (after a successful run) OR the pre-existing
   *  list (when idempotency short-circuits the skill call). Empty when
   *  the product row is missing or the skill returned zero candidates. */
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

/**
 * Core research logic. Loads the product, invokes the research skill
 * via `runForkSkill`, enriches via Reddit public API, persists top-3
 * with `source='auto'`. Returns the active subreddit list so
 * synchronous callers (the `research_reddit_channels` tool) can use it
 * directly without a follow-up query.
 *
 * Idempotent: when `force=false` and at least one auto row exists,
 * skips the skill call and returns the existing list. Manual rows
 * (`source='manual'`) are never touched on either path.
 *
 * The function never throws on enrichment / persistence failures it
 * can recover from (missing product row → empty result, skill returns
 * 0 candidates → empty result). Caller errors (bad userId/productId,
 * skill crashes, transaction failures) propagate.
 */
export async function runRedditChannelResearch(
  args: RunRedditChannelResearchArgs,
  ctx: ToolContext | Record<string, unknown> = {},
  log: Logger = baseLog,
): Promise<RunRedditChannelResearchResult> {
  const { userId, productId, force = false } = args;

  // Only count source='auto' rows toward idempotency — a re-research
  // after the founder has added manual entries still needs to run.
  if (!force) {
    const existing = await db
      .select({ id: productRedditChannels.id })
      .from(productRedditChannels)
      .where(
        and(
          eq(productRedditChannels.productId, productId),
          eq(productRedditChannels.source, 'auto'),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      log.info(`product ${productId} already researched — no-op`);
      const subreddits = await listActiveSubreddits(productId);
      return { subreddits, written: 0 };
    }
  }

  const [productRow] = await db
    .select({
      name: products.name,
      description: products.description,
      valueProp: products.valueProp,
    })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!productRow) {
    log.warn(`product ${productId} not found — aborting`);
    return { subreddits: [], written: 0 };
  }

  // Skill returns LLM-guessed memberCountApprox; we overwrite below
  // with the deterministic value from /about.json.
  const skillInput = {
    product: {
      name: productRow.name,
      description: productRow.description,
      valueProp: productRow.valueProp ?? undefined,
    },
    candidateCount: CANDIDATE_COUNT,
  };

  const { result } = await runForkSkill<ResearchingRedditChannelsOutput>(
    'researching-reddit-channels',
    JSON.stringify(skillInput),
    researchingRedditChannelsOutputSchema,
    { userId, productId, db, ...(ctx as Record<string, unknown>) },
  );

  const candidates = result.candidates ?? [];
  if (candidates.length === 0) {
    log.warn(`xAI returned 0 candidates for product ${productId}`);
    return { subreddits: [], written: 0 };
  }

  const top = [...candidates]
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, TOP_K);

  // Enrichment helpers swallow their own errors (404, rate-limited,
  // malformed payload), so Promise.all parallelism is safe — one bad
  // subreddit does not abort the batch.
  const enriched: NewProductRedditChannel[] = await Promise.all(
    top.map(async (c, i): Promise<NewProductRedditChannel> => {
      const [about, activity] = await Promise.all([
        fetchSubredditAbout(c.subreddit),
        fetchSubredditActivity(c.subreddit),
      ]);
      return {
        productId,
        userId,
        subreddit: c.subreddit,
        memberCount: about.memberCount ?? c.memberCountApprox ?? null,
        fitScore: c.fitScore,
        rulesSummary: c.rulesSummary,
        activity,
        rank: i + 1,
        source: 'auto',
        disabled: false,
      };
    }),
  );

  // Delete-then-insert is atomic in one transaction; we only touch
  // source='auto' rows so founder-added manual rows survive a re-research.
  await db.transaction(async (tx) => {
    await tx
      .delete(productRedditChannels)
      .where(
        and(
          eq(productRedditChannels.productId, productId),
          eq(productRedditChannels.source, 'auto'),
        ),
      );
    if (enriched.length > 0) {
      await tx.insert(productRedditChannels).values(enriched);
    }
  });

  log.info(
    `wrote ${enriched.length} auto reddit channels for product ${productId}`,
  );

  const subreddits = await listActiveSubreddits(productId);
  return { subreddits, written: enriched.length };
}

export async function processRedditChannelResearch(
  job: Job<RedditChannelResearchJobData>,
): Promise<void> {
  const log = loggerForJob(baseLog, job);
  const { userId, productId, force = false } = job.data;
  await runRedditChannelResearch({ userId, productId, force }, {}, log);
}
