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
 */
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { productRedditChannels, products } from '@/lib/db/schema';
import { runForkSkill } from '@/skills/run-fork-skill';
import { researchingRedditChannelsOutputSchema } from '@/skills/researching-reddit-channels/schema';
import {
  fetchSubredditAbout,
  fetchSubredditActivity,
} from '@/lib/reddit-channel-enrichment';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { RedditChannelResearchJobData } from '@/lib/queue';

const baseLog = createLogger('worker:reddit-channel-research');

/** Top-K winners persisted to product_reddit_channels per run. */
const TOP_K = 3;
/** Candidate count requested from the research skill (skill clamps 3..12). */
const CANDIDATE_COUNT = 6;

export async function processRedditChannelResearch(
  job: Job<RedditChannelResearchJobData>,
): Promise<void> {
  const log = loggerForJob(baseLog, job);
  const { userId, productId, force = false } = job.data;

  // 1. Idempotency gate. We only consider source='auto' rows so a
  //    re-research after a founder added manual entries still runs.
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
      return;
    }
  }

  // 2. Load product fields needed by the skill input.
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
    return;
  }

  // 3. Invoke the research skill (fork-mode). The skill returns
  //    candidates with LLM-guessed memberCountApprox; we overwrite
  //    these with deterministic values from /about.json below.
  const skillInput = {
    product: {
      name: productRow.name,
      description: productRow.description,
      valueProp: productRow.valueProp ?? undefined,
    },
    candidateCount: CANDIDATE_COUNT,
  };

  const { result } = await runForkSkill(
    'researching-reddit-channels',
    JSON.stringify(skillInput),
    researchingRedditChannelsOutputSchema,
    { userId, productId, db },
  );

  const candidates = result.candidates ?? [];
  if (candidates.length === 0) {
    log.warn(`xAI returned 0 candidates for product ${productId}`);
    return;
  }

  // 4. Sort by fitScore DESC, take top-K.
  const top = [...candidates]
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, TOP_K);

  // 5. Enrich in parallel. The helpers swallow their own errors and
  //    return null / zeroed activity rather than throwing, so one bad
  //    subreddit does not abort the batch.
  const enriched = await Promise.all(
    top.map(async (c, i) => {
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
        source: 'auto' as const,
        disabled: false,
      };
    }),
  );

  // 6. Atomic delete-then-insert. Only touches source='auto' rows so
  //    founder-added manual rows survive a re-research.
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
}
