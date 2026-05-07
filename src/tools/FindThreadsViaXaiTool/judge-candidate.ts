// Judge a single discovery candidate via the judging-thread-quality
// fork-skill. Extracted from FindThreadsViaXaiTool.ts so the per-platform
// arg construction lives next to the candidate types it knows about,
// keeping the parent file under the 800-line limit.

import type { ToolContext } from '@/core/types';
import { runForkSkill } from '@/skills/run-fork-skill';
import {
  judgingThreadQualityOutputSchema,
  type JudgingThreadQualityOutput,
} from '@/skills/judging-thread-quality/schema';
import type { TweetCandidate } from '@/tools/XaiFindCustomersTool/schema';
import type { RedditThreadCandidate } from './schemas';
import { createLogger } from '@/lib/logger';

const log = createLogger('tool:find_threads_via_xai:judge');

/** Platform-tagged discovery candidate. The judging fan-out and the
 *  persist call both need to handle either shape, so we tag at the
 *  boundary and discriminate on `platform`. */
export type DiscoveryCandidate =
  | { platform: 'x'; row: TweetCandidate }
  | { platform: 'reddit'; row: RedditThreadCandidate };

/** One judged candidate plus the verdict the skill returned. We carry
 *  BOTH the original row and the skill output so we can construct the
 *  full persist-time row (with canMentionProduct + mentionSignal)
 *  without re-judging. */
export interface JudgedCandidate {
  candidate: DiscoveryCandidate;
  verdict: JudgingThreadQualityOutput;
}

/** Minimal product fields the judging skill reads. */
export interface ProductForJudging {
  name: string;
  description: string;
  valueProp: string | null;
}

/**
 * Build the candidate args object the judging-thread-quality skill
 * receives. The skill's input shape is uniform across platforms
 * (title, body, author, authorBio, authorFollowers, url, platform,
 * postedAt) — each platform's row maps onto those fields slightly
 * differently:
 *   - X: `title` is a body-prefix slice (X tweets aren't titled);
 *     `authorBio`/`authorFollowers` come from xAI's enriched search.
 *   - Reddit: `title` is the real thread title; `authorBio` is null
 *     (Reddit doesn't expose bios via web_search) so the judging
 *     skill's competitor-bio filter simply doesn't fire on Reddit;
 *     `authorFollowers` is approximated by `author_karma` (sitewide
 *     karma is a comparable order-of-magnitude scale signal).
 */
export function buildJudgingArgs(
  candidate: DiscoveryCandidate,
  product: ProductForJudging,
): {
  candidate: {
    title: string;
    body: string;
    author: string;
    authorBio: string | null;
    authorFollowers: number | null;
    url: string;
    platform: 'x' | 'reddit';
    postedAt: string;
  };
  product: { name: string; description: string; valueProp?: string };
} {
  const productSection = {
    name: product.name,
    description: product.description,
    ...(product.valueProp ? { valueProp: product.valueProp } : {}),
  };
  if (candidate.platform === 'x') {
    return {
      candidate: {
        title: candidate.row.body.slice(0, 80),
        body: candidate.row.body,
        author: candidate.row.author_username,
        authorBio: candidate.row.author_bio,
        authorFollowers: candidate.row.author_followers,
        url: candidate.row.url,
        platform: 'x',
        postedAt: candidate.row.posted_at,
      },
      product: productSection,
    };
  }
  return {
    candidate: {
      title: candidate.row.title,
      body: candidate.row.body,
      author: candidate.row.author_username,
      authorBio: null,
      authorFollowers: candidate.row.author_karma,
      url: candidate.row.url,
      platform: 'reddit',
      postedAt: candidate.row.posted_at,
    },
    product: productSection,
  };
}

/**
 * Score a single candidate via the judging-thread-quality skill.
 *
 * Wraps runForkSkill so the per-round Promise.allSettled fan-out has
 * a stable promise shape. The output schema is passed through so
 * runAgent synthesizes the StructuredOutput tool with strict shape
 * validation; we ALSO safeParse defensively — the LLM can still
 * return partial output on a hiccup, and skipping a malformed
 * verdict is preferable to crashing the whole loop on
 * `j.verdict.signals` undefined access.
 *
 * Returns null when the fork's output is malformed; callers filter
 * nulls out before treating the result as a JudgedCandidate.
 */
export async function judgeCandidate(
  candidate: DiscoveryCandidate,
  product: ProductForJudging,
  ctx: ToolContext,
): Promise<JudgedCandidate | null> {
  const args = buildJudgingArgs(candidate, product);
  const { result } = await runForkSkill(
    'judging-thread-quality',
    JSON.stringify(args),
    judgingThreadQualityOutputSchema,
    ctx,
  );
  const parsed = judgingThreadQualityOutputSchema.safeParse(result);
  if (!parsed.success) {
    log.warn(
      `judging-thread-quality returned invalid output for ${candidate.row.external_id}: ${parsed.error.message}`,
    );
    return null;
  }
  return { candidate, verdict: parsed.data };
}
