// find_threads_via_xai — owns the conversational xAI Grok discovery loop.
// `execute()` IS the orchestrator: tracks message history, calls
// xai_find_customers per round, fans out to judging-thread-quality,
// aggregates rejection signals into mechanical refinement nudges,
// escalates to the reasoning Grok variant after 2 unsuccessful refines,
// caps at MAX_ROUNDS, persists keepers via persist_queue_threads.
// Per CLAUDE.md primitive boundaries: control flow is deterministic;
// LLM judgment lives ONLY in the leaf fork-skill calls + the xAI tool.

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import { channels, products } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';
import { xaiFindCustomersTool } from '@/tools/XaiFindCustomersTool/XaiFindCustomersTool';
import { persistQueueThreadsTool } from '@/tools/PersistQueueThreadsTool/PersistQueueThreadsTool';
import type { TweetCandidate } from '@/tools/XaiFindCustomersTool/schema';
import { type MentionSignal } from '@/skills/judging-thread-quality/schema';
import { MemoryStore } from '@/memory/store';
import { createLogger } from '@/lib/logger';
import { listRecentEngagedAuthors } from '@/lib/reply-throttle';
import { getReplyAuthorCooldownDays, PLATFORMS } from '@/lib/platform-config';
import {
  buildRedditFirstTurnMessage,
  buildXFirstTurnMessage,
} from './prompt-builders';
import {
  REDDIT_THREAD_SEARCH_SCHEMA,
  X_TWEET_SEARCH_SCHEMA,
  redditThreadSearchResponseSchema,
  type RedditThreadCandidate,
} from './schemas';
import {
  judgeCandidate,
  type DiscoveryCandidate,
  type JudgedCandidate,
} from './judge-candidate';
import {
  toTopQueued,
  type FindThreadsViaXaiTopQueued,
} from './top-queued';

export type { FindThreadsViaXaiTopQueued } from './top-queued';

const log = createLogger('tool:find_threads_via_xai');

export const FIND_THREADS_VIA_XAI_TOOL_NAME = 'find_threads_via_xai';

const inputSchema = z.object({
  trigger: z.enum(['kickoff', 'daily']).default('daily'),
  intent: z.string().optional(),
  maxResults: z.number().int().min(1).max(50).default(10),
  platform: z.enum([PLATFORMS.x.id, PLATFORMS.reddit.id] as ['x', 'reddit']).default(PLATFORMS.x.id as 'x'),
});

type DiscoveryPlatform = 'x' | 'reddit';

export interface FindThreadsViaXaiResult {
  queued: number;
  scanned: number;
  scoutNotes: string;
  costUsd: number;
  topQueued: FindThreadsViaXaiTopQueued[];
}

const MAX_ROUNDS = 10;
const STRONG_SCORE_THRESHOLD = 0.6;
const STRONG_RATIO = 0.8;
const REASONING_ESCALATE_AFTER_REFINES = 2;
const TOP_QUEUED_CAP = 20;

/**
 * Mechanical refinement table. Maps the most common rejection signals
 * the judging-thread-quality skill emits into a one-line nudge that
 * gets appended to the next xAI user message. Keys mirror the signal
 * vocabulary the skill returns; we silently drop unknown signals so
 * skill drift doesn't crash the loop.
 */
const SIGNAL_NUDGE: Record<string, string> = {
  competitor_bio:
    'drop accounts whose bios mention competing tools or "growth tips"',
  engagement_pod:
    'avoid threads with engagement-pod patterns (rapid early replies from familiar handles)',
  advice_giver: 'skip accounts that are teaching, not asking',
  political:
    'skip political / culture-war threads regardless of keyword match',
  competitor_complaint:
    'keep these — they are valid but currently mis-tagged elsewhere; do not refine away',
  milestone:
    'avoid celebration / milestone threads unless OP is asking for input',
  vulnerable:
    'avoid burnout / hardship threads — peer-mode replies only, not lead-gen',
  no_fit: 'broaden the keyword set — current query is too narrow',
};

export interface ProductForLoop {
  id: string;
  name: string;
  description: string;
  valueProp: string | null;
  targetAudience: string | null;
  keywords: string[];
}

interface XaiMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface XaiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Stable external_id accessor — the field name happens to match on
 *  both X and Reddit candidate shapes, but the discriminator keeps
 *  TS happy. */
function externalId(c: DiscoveryCandidate): string {
  return c.row.external_id;
}

/** Stable url accessor for the refinement message + topQueued. */
function candidateUrl(c: DiscoveryCandidate): string {
  return c.row.url;
}

/**
 * xAI rough-cost model. Grok pricing isn't in the codebase; we
 * approximate at $5/M input + $15/M output (parity with Sonnet)
 * because the agent's old prose said "rough estimate from token
 * counts is fine; the team-run worker captures Anthropic costs
 * separately". Keeping it deterministic + bounded so the StructuredOutput
 * stays consistent across runs.
 */
const XAI_INPUT_PRICE_PER_1M = 5;
const XAI_OUTPUT_PRICE_PER_1M = 15;

function xaiUsageToCostUsd(u: XaiUsage): number {
  return (
    (u.inputTokens / 1_000_000) * XAI_INPUT_PRICE_PER_1M +
    (u.outputTokens / 1_000_000) * XAI_OUTPUT_PRICE_PER_1M
  );
}

/**
 * Engagement-weighted score — same formula the persist tool uses on X
 * so `topQueued` ordering matches the threads-table insertion order.
 *
 * Both platforms use `confidence × log10(1 + weighted_engagement)`.
 *   - X: likes + 5×reposts (a public endorsement is meaningfully
 *     stronger signal than a passive like).
 *   - Reddit: score (net upvotes) + 5×num_comments (a comment is
 *     meaningfully stronger participation signal than a passive
 *     upvote).
 */
function engagementScore(c: DiscoveryCandidate): number {
  if (c.platform === 'x') {
    const likes = c.row.likes_count ?? 0;
    const reposts = c.row.reposts_count ?? 0;
    return c.row.confidence * Math.log10(1 + likes + 5 * reposts);
  }
  const score = c.row.score;
  const comments = c.row.num_comments;
  return c.row.confidence * Math.log10(1 + score + 5 * comments);
}

/**
 * Thin X-platform delegate to `buildXFirstTurnMessage` in
 * `prompt-builders.ts`. Preserved as the canonical export for the
 * existing in-file call site and the existing unit tests. Reddit
 * discovery skips this and calls `buildRedditFirstTurnMessage`
 * directly. Self-handle injection now flows through the platform
 * branch in `execute()`; this helper passes `null` so legacy callers
 * (and the existing tests) see no behavioral change.
 */
export function buildFirstTurnMessage(
  product: ProductForLoop,
  rubric: string,
  intent: string | undefined,
  maxResults: number,
  excludeAuthors: readonly string[],
): string {
  return buildXFirstTurnMessage(
    product,
    rubric,
    intent,
    maxResults,
    excludeAuthors,
    null,
  );
}

/**
 * Mechanical refinement message. Aggregates the top-3 rejection
 * signals into a one-line nudge and points xAI at example URLs of
 * strong matches we've already accepted. Exported for unit testing.
 */
export function composeRefinementMessage(
  rejectionSignals: Map<string, number>,
  strongUrls: string[],
  excludeAuthors: readonly string[],
): string {
  const top = [...rejectionSignals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const nudges = top
    .map(([sig]) => SIGNAL_NUDGE[sig])
    .filter((n): n is string => Boolean(n));
  const followLike =
    strongUrls.length > 0
      ? `Find more like ${strongUrls.slice(0, 2).join(' / ')}.`
      : '';
  const REFINEMENT_AUTHOR_LIMIT = 10;
  const skipReminder =
    excludeAuthors.length > 0
      ? `Still skip ${excludeAuthors
          .slice(0, REFINEMENT_AUTHOR_LIMIT)
          .map((h) => '@' + h)
          .join(', ')}.`
      : '';
  return [
    `Found ${strongUrls.length} strong matches.`,
    nudges.length > 0 ? `Refine: ${nudges.join('; ')}.` : '',
    followLike,
    skipReminder,
  ]
    .filter(Boolean)
    .join(' ');
}

async function loadRubric(
  userId: string,
  productId: string,
): Promise<string> {
  try {
    const store = new MemoryStore(userId, productId);
    const entry = await store.loadEntry('discovery-rubric');
    return entry?.content ?? '';
  } catch (err) {
    log.warn(
      `discovery-rubric load failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return '';
  }
}

export const findThreadsViaXaiTool = buildTool({
  name: FIND_THREADS_VIA_XAI_TOOL_NAME,
  description:
    'Run the conversational xAI Grok discovery loop, judge each ' +
    'candidate via judging-thread-quality, persist keepers to the ' +
    'threads table. Multi-round with mechanical refinement (top-3 ' +
    'rejection signals → one-line nudge), escalates to the reasoning ' +
    'Grok variant ONCE after 2 unsuccessful refines, capped at 10 ' +
    'rounds. Returns the same shape discovery-agent\'s StructuredOutput ' +
    'uses today: { queued, scanned, scoutNotes, costUsd, topQueued }.\n\n' +
    'INPUT: { "trigger": "kickoff"|"daily", "intent"?: string, "maxResults"?: number (1-50, default 10) }',
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input, ctx): Promise<FindThreadsViaXaiResult> {
    const { db, userId, productId } = readDomainDeps(ctx);

    // Normalize defaults — buildTool's TInput infers from `z.input(schema)`,
    // so `default(...)` fields are still optional at the function-signature
    // boundary. The schema's `.parse()` populates them at runtime, but TS
    // sees them as possibly-undefined here.
    const trigger = input.trigger ?? 'daily';
    const maxResults = input.maxResults ?? 10;
    const platform: DiscoveryPlatform =
      (input.platform as DiscoveryPlatform | undefined) ??
      (PLATFORMS.x.id as 'x');
    void trigger; // currently informational; reserved for future telemetry

    // Load product + rubric. The agent's old prose ran read_memory then
    // composed the first xAI message — same flow, just deterministic.
    const productRows = await db
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        valueProp: products.valueProp,
        targetAudience: products.targetAudience,
        keywords: products.keywords,
      })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    const productRow = productRows[0];
    if (!productRow) {
      throw new Error(
        `find_threads_via_xai: product ${productId} not found`,
      );
    }
    const product: ProductForLoop = {
      id: productRow.id,
      name: productRow.name,
      description: productRow.description,
      valueProp: productRow.valueProp,
      targetAudience: productRow.targetAudience,
      keywords: productRow.keywords ?? [],
    };

    const rubric = await loadRubric(userId, productId);

    // Look up the founder's own handle on this platform so we can tell
    // xAI not to surface their own posts as reply targets. Projection
    // limited to `username` so we never pull encrypted token columns
    // through this read path. Missing channel → null → no self-line in
    // the prompt (the founder hasn't connected this platform yet).
    let excludeSelfHandle: string | null = null;
    try {
      const ownChannelRows = await db
        .select({ username: channels.username })
        .from(channels)
        .where(
          and(eq(channels.userId, userId), eq(channels.platform, platform)),
        )
        .limit(1);
      excludeSelfHandle = ownChannelRows[0]?.username ?? null;
    } catch (err) {
      log.warn(
        `channel self-handle lookup failed; proceeding without self-exclude: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    let excludeAuthors: string[] = [];
    try {
      excludeAuthors = await listRecentEngagedAuthors(db, {
        userId,
        platform,
        withinDays: getReplyAuthorCooldownDays(platform),
        limit: 80, // headroom over the prompt cap of 50; refinement caps at 10
      });
    } catch (err) {
      log.warn(
        `reply-throttle list fetch failed; proceeding without exclude list: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const productContext = {
      name: product.name,
      description: product.description,
      valueProp: product.valueProp,
      targetAudience: product.targetAudience,
      keywords: product.keywords,
    };

    // Branch search tool, prompt builder, and JSON schema by platform.
    // X uses xAI's first-class `x_search` tool. Reddit uses generic
    // `web_search` restricted to reddit.com (xAI doesn't expose a
    // Reddit-specific search tool, but the search engine indexes
    // reddit.com richly enough that this works in practice — see the
    // Reddit handoff design doc for the validation findings).
    const xaiTools =
      platform === 'reddit'
        ? [
            {
              type: 'web_search' as const,
              filters: { allowed_domains: ['reddit.com'] as string[] },
            },
          ]
        : [{ type: 'x_search' as const }];

    const firstTurnContent =
      platform === 'reddit'
        ? buildRedditFirstTurnMessage(
            product,
            rubric,
            input.intent,
            maxResults,
            excludeAuthors,
            excludeSelfHandle,
          )
        : buildXFirstTurnMessage(
            product,
            rubric,
            input.intent,
            maxResults,
            excludeAuthors,
            excludeSelfHandle,
          );

    const responseFormatSchema =
      platform === 'reddit' ? REDDIT_THREAD_SEARCH_SCHEMA : X_TWEET_SEARCH_SCHEMA;
    const responseFormatName =
      platform === 'reddit'
        ? 'reddit_thread_search_result'
        : 'tweet_search_result';

    // Conversational state — we OWN this. xAI is stateless server-side;
    // every call carries the full prior turns.
    const messages: XaiMessage[] = [
      {
        role: 'user',
        content: firstTurnContent,
      },
    ];

    // Strong = keep:true AND score>=0.6. Tracked across rounds and
    // deduplicated by external_id so the persist call sees one row per
    // candidate even if xAI surfaces the same tweet twice.
    const strong = new Map<string, JudgedCandidate>();
    // All judged candidates across rounds (for `scanned` count) — also
    // deduped by external_id.
    const seen = new Set<string>();
    let totalScanned = 0;
    let totalCostUsd = 0;
    const accumulatedRejectionSignals = new Map<string, number>();
    // The last non-empty notes string xAI returned. Used as scoutNotes
    // when we end the loop without enough strong matches.
    let lastXaiNotes = '';
    let consecutiveEmptyRounds = 0;
    let unsuccessfulRefines = 0;
    let reasoningEscalated = false;
    let reachedTarget = false;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const reasoning = !reasoningEscalated
        ? false
        : // Once escalated we keep reasoning ON for any subsequent
          // round in this run (rare — typically the escalation round
          // succeeds and we break).
          true;
      // Escalate exactly once: when we've already done 2 refines that
      // didn't converge AND we haven't escalated yet.
      const shouldEscalateNow =
        !reasoningEscalated &&
        unsuccessfulRefines >= REASONING_ESCALATE_AFTER_REFINES;
      const callReasoning = shouldEscalateNow ? true : reasoning;
      if (shouldEscalateNow) reasoningEscalated = true;

      if (shouldEscalateNow) {
        ctx.emitProgress?.(
          FIND_THREADS_VIA_XAI_TOOL_NAME,
          `Escalating to reasoning mode after ${unsuccessfulRefines} refines…`,
          { round: round + 1, unsuccessfulRefines },
        );
      }

      ctx.emitProgress?.(
        FIND_THREADS_VIA_XAI_TOOL_NAME,
        `Round ${round + 1} — querying xAI${callReasoning ? ' (reasoning)' : ''}…`,
        { round: round + 1, reasoning: callReasoning, strongSoFar: strong.size },
      );

      let xaiResult;
      try {
        xaiResult = await xaiFindCustomersTool.execute(
          {
            messages,
            productContext,
            reasoning: callReasoning,
            tools: xaiTools,
            responseFormatSchema,
            responseFormatName,
          },
          ctx,
        );
      } catch (err) {
        log.warn(
          `xai_find_customers round ${round + 1} threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        break;
      }

      totalCostUsd += xaiUsageToCostUsd(xaiResult.usage);
      if (xaiResult.notes) lastXaiNotes = xaiResult.notes;

      // Extend conversation with xAI's assistant turn so the next
      // iteration's call carries full context. Mirrors the discovery
      // agent's prior workflow.
      messages.push(xaiResult.assistantMessage);

      // Normalize the per-round response into a uniform candidate
      // array. X path uses `xaiResult.tweets` (Zod-validated by the
      // inner tool). Reddit path goes through the inner tool's custom-
      // schema branch — `tweets` is empty and the raw JSON is in
      // `output`; we re-validate against `redditThreadSearchResponseSchema`.
      let roundCandidates: DiscoveryCandidate[] = [];
      if (platform === 'x') {
        roundCandidates = xaiResult.tweets.map((t) => ({
          platform: 'x' as const,
          row: t,
        }));
      } else {
        const parsed = redditThreadSearchResponseSchema.safeParse(
          xaiResult.output,
        );
        if (!parsed.success) {
          log.warn(
            `find_threads_via_xai round ${round + 1} (reddit): output ` +
              `failed reddit-thread schema validation: ${parsed.error.message}`,
          );
        } else {
          if (parsed.data.notes) lastXaiNotes = parsed.data.notes;
          roundCandidates = parsed.data.threads.map((t) => ({
            platform: 'reddit' as const,
            row: t,
          }));
        }
      }

      // Filter out candidates we've already judged in a prior round.
      const fresh = roundCandidates.filter(
        (c) => !seen.has(externalId(c)),
      );
      for (const c of fresh) seen.add(externalId(c));

      if (fresh.length === 0) {
        consecutiveEmptyRounds += 1;
        // Two consecutive empty rounds = xAI has nothing more to give.
        // Stop, persist 0, return scoutNotes explaining.
        if (consecutiveEmptyRounds >= 2) {
          break;
        }
        // Even with no fresh candidates, still treat as an unsuccessful
        // refine so the reasoning escalation kicks in eventually.
        unsuccessfulRefines += 1;
        const refinement = composeRefinementMessage(
          accumulatedRejectionSignals,
          [...strong.values()].map((j) => candidateUrl(j.candidate)),
          excludeAuthors,
        );
        messages.push({
          role: 'user',
          content: refinement || 'Try broader keywords. No fresh matches yet.',
        });
        continue;
      }
      consecutiveEmptyRounds = 0;

      ctx.emitProgress?.(
        FIND_THREADS_VIA_XAI_TOOL_NAME,
        `Round ${round + 1} — judging ${fresh.length} candidate${fresh.length === 1 ? '' : 's'}…`,
        { round: round + 1, candidateCount: fresh.length },
      );

      // Fan out judging in parallel — Plan 2 lessons: allSettled so one
      // judging fork's exception doesn't lose the whole round. Also
      // tolerates malformed verdicts (judgeCandidate returns null when
      // safeParse fails) so a single bad LLM hiccup doesn't crash the
      // round. Bounded parallelism: xAI returns ≤50 (X) / ≤20 (Reddit)
      // per call, typically 10-20, which is fine without chunking.
      const settled = await Promise.allSettled(
        fresh.map((c) => judgeCandidate(c, product, ctx)),
      );
      const judged: JudgedCandidate[] = [];
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i]!;
        if (s.status === 'fulfilled' && s.value !== null) {
          judged.push(s.value);
        } else if (s.status === 'rejected') {
          log.warn(
            `judging-thread-quality fork rejected for ${
              fresh[i] ? externalId(fresh[i]!) : 'unknown'
            }: ${
              s.reason instanceof Error ? s.reason.message : String(s.reason)
            }`,
          );
        }
        // s.value === null means safeParse failed — already logged
        // inside judgeCandidate.
      }

      totalScanned = seen.size;

      let strongInThisRound = 0;
      let rejectedInThisRound = 0;
      for (const j of judged) {
        if (j.verdict.keep && j.verdict.score >= STRONG_SCORE_THRESHOLD) {
          strong.set(externalId(j.candidate), j);
          strongInThisRound += 1;
        } else if (!j.verdict.keep) {
          rejectedInThisRound += 1;
          // Aggregate the dominant rejection signals so the next refine
          // message can address them.
          for (const sig of j.verdict.signals) {
            accumulatedRejectionSignals.set(
              sig,
              (accumulatedRejectionSignals.get(sig) ?? 0) + 1,
            );
          }
        }
      }

      const topRejectionForRound = [...accumulatedRejectionSignals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      ctx.emitProgress?.(
        FIND_THREADS_VIA_XAI_TOOL_NAME,
        `Round ${round + 1} — ${strongInThisRound} strong, ${rejectedInThisRound} rejected${
          topRejectionForRound ? ` (${topRejectionForRound})` : ''
        }`,
        {
          round: round + 1,
          strongInThisRound,
          rejectedInThisRound,
          totalStrong: strong.size,
        },
      );

      // Convergence check. The agent's old prose: "≥ maxResults × 0.8
      // with keep:true AND score≥0.6, OR all of maxResults regardless
      // of score". We've collapsed to the strong-only branch; the
      // alternate "any keepers regardless of score" path is left to
      // MAX_ROUNDS exhaustion.
      if (strong.size >= Math.ceil(maxResults * STRONG_RATIO)) {
        reachedTarget = true;
        break;
      }

      // Otherwise compose refinement and loop. If THIS round also
      // produced no strong matches, that's an unsuccessful refine —
      // count it so reasoning escalates after 2.
      if (strongInThisRound === 0) {
        unsuccessfulRefines += 1;
      }
      const refinement = composeRefinementMessage(
        accumulatedRejectionSignals,
        [...strong.values()].map((j) => candidateUrl(j.candidate)),
        excludeAuthors,
      );
      messages.push({
        role: 'user',
        content:
          refinement ||
          `Found ${strong.size} so far. Keep looking — same constraints.`,
      });
    }

    // Build persist input. Cap at maxResults so we don't over-persist
    // when xAI was generous.
    const ranked = [...strong.values()]
      .sort(
        (a, b) => engagementScore(b.candidate) - engagementScore(a.candidate),
      )
      .slice(0, maxResults);

    // X path: build TweetCandidate rows and pass them straight through
    // to persist_queue_threads (existing X persist behavior).
    // Reddit path: persist mapping lives in PersistQueueThreadsTool's
    // Reddit branch (Task 2c) — for now pass the platform tag through
    // so 2c has a hook to read. Until 2c lands, the Reddit branch of
    // the persist call is a no-op (the tool's input schema today only
    // accepts X tweet rows; we therefore only call persist on X).
    let inserted = 0;
    if (platform === PLATFORMS.x.id) {
      const xRanked = ranked.filter(
        (j): j is JudgedCandidate & {
          candidate: { platform: 'x'; row: TweetCandidate };
        } => j.candidate.platform === 'x',
      );
      const threadsToPersist: TweetCandidate[] = xRanked.map((j) => ({
        ...j.candidate.row,
        can_mention_product: j.verdict.canMentionProduct,
        mention_signal: j.verdict.mentionSignal as MentionSignal,
      }));
      if (threadsToPersist.length > 0) {
        ctx.emitProgress?.(
          FIND_THREADS_VIA_XAI_TOOL_NAME,
          `Persisting ${threadsToPersist.length} thread${threadsToPersist.length === 1 ? '' : 's'}…`,
          { count: threadsToPersist.length },
        );
        const persistResult = await persistQueueThreadsTool.execute(
          { platform: PLATFORMS.x.id as 'x', threads: threadsToPersist },
          ctx,
        );
        inserted = persistResult.inserted;
      }
    } else {
      // Reddit persist (Task 2c). Reddit's RedditThreadCandidate Zod
      // schema doesn't carry can_mention_product/mention_signal — we
      // spread the verdict's flags onto the row anyway because the
      // persist mapper reads them off the row defensively.
      const redditRanked = ranked.filter(
        (j): j is JudgedCandidate & {
          candidate: { platform: 'reddit'; row: RedditThreadCandidate };
        } => j.candidate.platform === 'reddit',
      );
      const redditThreadsToPersist: RedditThreadCandidate[] = redditRanked.map(
        (j) =>
          ({
            ...j.candidate.row,
            can_mention_product: j.verdict.canMentionProduct,
            mention_signal: j.verdict.mentionSignal as MentionSignal,
          }) as RedditThreadCandidate,
      );
      if (redditThreadsToPersist.length > 0) {
        ctx.emitProgress?.(
          FIND_THREADS_VIA_XAI_TOOL_NAME,
          `Persisting ${redditThreadsToPersist.length} thread${redditThreadsToPersist.length === 1 ? '' : 's'}…`,
          { count: redditThreadsToPersist.length },
        );
        const persistResult = await persistQueueThreadsTool.execute(
          {
            platform: PLATFORMS.reddit.id as 'reddit',
            threads: redditThreadsToPersist,
          },
          ctx,
        );
        inserted = persistResult.inserted;
      }
    }

    const topQueued: FindThreadsViaXaiTopQueued[] = ranked
      .slice(0, TOP_QUEUED_CAP)
      .map(toTopQueued);

    const scoutNotes = composeScoutNotes({
      reachedTarget,
      strongCount: strong.size,
      scanned: totalScanned,
      maxResults: maxResults,
      reasoningEscalated,
      lastXaiNotes,
      rejectionSignals: accumulatedRejectionSignals,
    });

    log.info(
      `find_threads_via_xai user=${userId} scanned=${totalScanned} ` +
        `strong=${strong.size} queued=${inserted} reasoning_escalated=${reasoningEscalated}`,
    );

    return {
      queued: inserted,
      scanned: totalScanned,
      scoutNotes,
      costUsd: totalCostUsd,
      topQueued,
    };
  },
});

interface ScoutNotesInput {
  reachedTarget: boolean;
  strongCount: number;
  scanned: number;
  maxResults: number;
  reasoningEscalated: boolean;
  lastXaiNotes: string;
  rejectionSignals: Map<string, number>;
}

function composeScoutNotes(input: ScoutNotesInput): string {
  const parts: string[] = [];
  if (input.scanned === 0) {
    parts.push(
      'xAI returned 0 candidates across all rounds — no ICP matches found.',
    );
  } else if (input.reachedTarget) {
    parts.push(
      `Found ${input.strongCount} strong matches (target ${Math.ceil(
        input.maxResults * STRONG_RATIO,
      )}) after scanning ${input.scanned} candidates.`,
    );
  } else {
    parts.push(
      `Scanned ${input.scanned} candidates; ${input.strongCount} met the ` +
        `keep+score≥${STRONG_SCORE_THRESHOLD} bar (target ${Math.ceil(
          input.maxResults * STRONG_RATIO,
        )}). Loop ended at MAX_ROUNDS or two empty rounds.`,
    );
  }
  if (input.reasoningEscalated) {
    parts.push('Escalated to reasoning Grok after 2 unsuccessful refines.');
  }
  if (input.rejectionSignals.size > 0) {
    const top = [...input.rejectionSignals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    parts.push(`Top rejection signals: ${top}.`);
  }
  if (input.lastXaiNotes) {
    parts.push(`xAI: ${input.lastXaiNotes.slice(0, 200)}`);
  }
  return parts.join(' ');
}
