// find_threads_via_xai — owns the conversational xAI Grok discovery loop
// that used to live as prose inside `discovery-agent/AGENT.md`. The
// Tool's `execute()` IS the orchestrator: it tracks the xAI message
// history, calls `xai_find_customers` per round, fans out to
// `judging-thread-quality` for per-candidate verdicts, aggregates
// rejection signals into mechanical refinement nudges, escalates to
// the reasoning-enabled Grok variant after two unsuccessful refines,
// caps at MAX_ROUNDS, and persists the deduped keepers via
// `persist_queue_threads`.
//
// Per CLAUDE.md primitive boundaries:
//   - The control-flow logic (when to refine, when to escalate, when to
//     persist) is deterministic — no LLM in the loop's branch points.
//   - LLM judgment lives ONLY inside the leaf fork-skill calls
//     (judging-thread-quality) and the xAI tool itself.
//   - Refinement message composition is mechanical (SIGNAL_NUDGE table).
//
// Returns the same StructuredOutput shape discovery-agent emits today
// so the coordinator's downstream dispatch logic doesn't change.

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolContext } from '@/core/types';
import { products } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';
import { runForkSkill } from '@/skills/run-fork-skill';
import { xaiFindCustomersTool } from '@/tools/XaiFindCustomersTool/XaiFindCustomersTool';
import { persistQueueThreadsTool } from '@/tools/PersistQueueThreadsTool/PersistQueueThreadsTool';
import type { TweetCandidate } from '@/tools/XaiFindCustomersTool/schema';
import type {
  JudgingThreadQualityOutput,
  MentionSignal,
} from '@/skills/judging-thread-quality/schema';
import { MemoryStore } from '@/memory/store';
import { createLogger } from '@/lib/logger';

const log = createLogger('tool:find_threads_via_xai');

export const FIND_THREADS_VIA_XAI_TOOL_NAME = 'find_threads_via_xai';

const inputSchema = z.object({
  trigger: z.enum(['kickoff', 'daily']).default('daily'),
  intent: z.string().optional(),
  maxResults: z.number().int().min(1).max(50).default(10),
});


export interface FindThreadsViaXaiTopQueued {
  externalId: string;
  url: string;
  authorUsername: string;
  body: string;
  likesCount: number | null;
  repostsCount: number | null;
  confidence: number;
}

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

interface ProductForLoop {
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

/**
 * One judged candidate plus the verdict the skill returned. We carry
 * BOTH the original tweet and the skill output so we can construct the
 * full TweetCandidate row to persist (with canMentionProduct +
 * mentionSignal) without re-judging.
 */
interface JudgedCandidate {
  tweet: TweetCandidate;
  verdict: JudgingThreadQualityOutput;
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
 * Engagement-weighted score — same formula the persist tool uses so
 * `topQueued` ordering matches the threads-table insertion order.
 */
function engagementScore(t: TweetCandidate): number {
  const likes = t.likes_count ?? 0;
  const reposts = t.reposts_count ?? 0;
  return t.confidence * Math.log10(1 + likes + 5 * reposts);
}

/** Build the first-turn xAI user message from product + rubric + intent. */
export function buildFirstTurnMessage(
  product: ProductForLoop,
  rubric: string,
  intent: string | undefined,
  maxResults: number,
): string {
  const keywords =
    product.keywords.length > 0 ? product.keywords.join(', ') : '(none)';
  const intentLine = intent ? `\nFOUNDER INTENT\n${intent}\n` : '';
  const rubricSection = rubric
    ? `\nICP RUBRIC (from onboarding)\n${rubric}\n`
    : '';
  return [
    "I'm looking for X/Twitter posts where potential customers of my product",
    'are publicly expressing problems the product solves.',
    '',
    'PRODUCT',
    `- Name: ${product.name}`,
    `- Description: ${product.description}`,
    `- Value prop: ${product.valueProp ?? '(not specified)'}`,
    `- Target audience: ${product.targetAudience ?? '(not specified)'}`,
    `- Keywords: ${keywords}`,
    intentLine + rubricSection,
    'Constraints',
    '- Posted in last 7 days',
    `- Up to ${maxResults * 2} candidates this pass — quality over quota`,
    '- For each tweet include: url, author_username, author_bio, author_followers,',
    '  body, posted_at, likes_count, reposts_count, replies_count, views_count,',
    '  is_repost, original_url, original_author_username, surfaced_via,',
    '  confidence (your 0-1 assessment), reason (1 sentence, product-specific)',
    '- Reposts ARE valuable signal — when a relevant person reposts a thread on',
    "  the product's pain, that thread is a strong reply target. Include reposts;",
    '  do NOT filter them out as noise. The reply target for a repost is the',
    '  ORIGINAL author (set original_url + original_author_username; surfaced_via',
    '  carries the reposter handle).',
    "- Empty `tweets` is allowed if you genuinely find nothing — don't pad.",
  ].join('\n');
}

/**
 * Mechanical refinement message. Aggregates the top-3 rejection
 * signals into a one-line nudge and points xAI at example URLs of
 * strong matches we've already accepted. Exported for unit testing.
 */
export function composeRefinementMessage(
  rejectionSignals: Map<string, number>,
  strongUrls: string[],
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
  return [
    `Found ${strongUrls.length} strong matches.`,
    nudges.length > 0 ? `Refine: ${nudges.join('; ')}.` : '',
    followLike,
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

/**
 * Score a single candidate via the judging-thread-quality skill.
 * Wraps runForkSkill so the per-round Promise.allSettled fan-out has
 * a stable promise shape. Errors propagate so allSettled can surface
 * them — we drop just the failed candidate, never lose the round.
 */
async function judgeCandidate(
  tweet: TweetCandidate,
  product: ProductForLoop,
  ctx: ToolContext,
): Promise<JudgedCandidate> {
  const args = {
    candidate: {
      title: tweet.body.slice(0, 80),
      body: tweet.body,
      author: tweet.author_username,
      url: tweet.url,
      platform: 'x' as const,
      postedAt: tweet.posted_at,
    },
    product: {
      name: product.name,
      description: product.description,
      ...(product.valueProp ? { valueProp: product.valueProp } : {}),
    },
  };
  const { result } = await runForkSkill<JudgingThreadQualityOutput>(
    'judging-thread-quality',
    JSON.stringify(args),
    undefined,
    ctx,
  );
  return { tweet, verdict: result };
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

    const productContext = {
      name: product.name,
      description: product.description,
      valueProp: product.valueProp,
      targetAudience: product.targetAudience,
      keywords: product.keywords,
    };

    // Conversational state — we OWN this. xAI is stateless server-side;
    // every call carries the full prior turns.
    const messages: XaiMessage[] = [
      {
        role: 'user',
        content: buildFirstTurnMessage(
          product,
          rubric,
          input.intent,
          maxResults,
        ),
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

      let xaiResult;
      try {
        xaiResult = await xaiFindCustomersTool.execute(
          {
            messages,
            productContext,
            reasoning: callReasoning,
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

      // Filter out tweets we've already judged in a prior round.
      const fresh = xaiResult.tweets.filter(
        (t) => !seen.has(t.external_id),
      );
      for (const t of fresh) seen.add(t.external_id);

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
          [...strong.values()].map((j) => j.tweet.url),
        );
        messages.push({
          role: 'user',
          content: refinement || 'Try broader keywords. No fresh matches yet.',
        });
        continue;
      }
      consecutiveEmptyRounds = 0;

      // Fan out judging in parallel — Plan 2 lessons: allSettled so one
      // judging fork's exception doesn't lose the whole round.
      // Bounded parallelism: xAI returns ≤50 (schema cap) per call,
      // typically 10-20, which is fine without chunking.
      const settled = await Promise.allSettled(
        fresh.map((t) => judgeCandidate(t, product, ctx)),
      );
      const judged: JudgedCandidate[] = [];
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i]!;
        if (s.status === 'fulfilled') {
          judged.push(s.value);
        } else {
          log.warn(
            `judging-thread-quality fork rejected for ${
              fresh[i]?.external_id
            }: ${
              s.reason instanceof Error ? s.reason.message : String(s.reason)
            }`,
          );
        }
      }

      totalScanned = seen.size;

      let strongInThisRound = 0;
      for (const j of judged) {
        if (j.verdict.keep && j.verdict.score >= STRONG_SCORE_THRESHOLD) {
          strong.set(j.tweet.external_id, j);
          strongInThisRound += 1;
        } else if (!j.verdict.keep) {
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
        [...strong.values()].map((j) => j.tweet.url),
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
        (a, b) => engagementScore(b.tweet) - engagementScore(a.tweet),
      )
      .slice(0, maxResults);

    const threadsToPersist: TweetCandidate[] = ranked.map((j) => ({
      ...j.tweet,
      can_mention_product: j.verdict.canMentionProduct,
      mention_signal: j.verdict.mentionSignal as MentionSignal,
    }));

    let inserted = 0;
    if (threadsToPersist.length > 0) {
      const persistResult = await persistQueueThreadsTool.execute(
        { threads: threadsToPersist },
        ctx,
      );
      inserted = persistResult.inserted;
    }

    const topQueued: FindThreadsViaXaiTopQueued[] = ranked
      .slice(0, TOP_QUEUED_CAP)
      .map((j) => ({
        externalId: j.tweet.external_id,
        url: j.tweet.url,
        authorUsername: j.tweet.author_username,
        body: j.tweet.body,
        likesCount: j.tweet.likes_count,
        repostsCount: j.tweet.reposts_count,
        confidence: j.verdict.score,
      }));

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
