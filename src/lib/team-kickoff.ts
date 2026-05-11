/**
 * Team kickoff bootstrap. Idempotent helper that dispatches a single
 * kickoff lead message the first time a (user, product, team) is
 * observed, then never again. The kickoff run produces the three
 * artefacts the founder sees on their first visit to /team:
 *   1. plan draft (coordinator's add_plan_item tool — direct, post-Plan-3)
 *   2. reply-target discovery (rolled into the social-media-manager spawn)
 *   3. draft replies (social-media-manager on the discovered top targets)
 *
 * Called from `app/(app)/team/page.tsx` server component on every render —
 * the first call schedules the run, subsequent calls are cheap no-ops.
 * Keeping the trigger here (and not in `/api/onboarding/commit`) means the
 * AI team is visibly working when the founder lands on the team page,
 * not silently in the background while they're still on the onboarding
 * "thanks!" screen.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  products,
  strategicPaths,
  teamMembers,
  teamMessages,
} from '@/lib/db/schema';
import { getUserChannels } from '@/lib/user-channels';
import { dispatchLeadMessage } from '@/lib/team/dispatch-lead-message';
import { createAutomationConversation } from '@/lib/team-conversation-helpers';
import { currentWeekStart } from '@/lib/week-bounds';
import { createLogger } from '@/lib/logger';
import { derivePerWeekPosts } from '@/lib/strategic-path-helpers';
import type { StrategicPath } from '@/tools/schemas';

const log = createLogger('lib:team-kickoff');

export interface EnsureKickoffResult {
  fired: boolean;
  reason?: 'already_kickoffed' | 'no_product' | 'no_coordinator' | 'enqueue_failed';
  runId?: string;
  conversationId?: string;
}

/**
 * Idempotently dispatch the kickoff lead message for `(userId, teamId)`.
 *
 * Detection: we look in `team_messages.metadata.trigger` for ANY past
 * `kickoff` row (any status). One kickoff per team, ever — re-running
 * is a manual action, not an automatic one.
 */
export async function ensureKickoffEnqueued(args: {
  userId: string;
  productId: string;
  teamId: string;
}): Promise<EnsureKickoffResult> {
  const { userId, productId, teamId } = args;

  // Has this team ever kicked off? Status doesn't matter — we just want
  // the founder's one-shot auto-kickoff. `dispatchLeadMessage` stamps
  // `metadata.trigger` on every user_prompt, so a single SELECT on
  // team_messages is the source of truth. Manual re-runs go through
  // /api/team/run as before.
  const existing = await db
    .select({ id: teamMessages.id })
    .from(teamMessages)
    .where(
      and(
        eq(teamMessages.teamId, teamId),
        sql`${teamMessages.metadata}->>'trigger' = 'kickoff'`,
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return { fired: false, reason: 'already_kickoffed' };
  }

  const [productRow] = await db
    .select({ name: products.name })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (!productRow) {
    return { fired: false, reason: 'no_product' };
  }

  const memberRows = await db
    .select({ id: teamMembers.id, agentType: teamMembers.agentType })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  const coordinator = memberRows.find((m) => m.agentType === 'coordinator');
  if (!coordinator) {
    return { fired: false, reason: 'no_coordinator' };
  }

  const channels = await getUserChannels(userId);

  // Pre-compute the calendar anchor so the goal preamble can pass it
  // verbatim to the coordinator. Without `weekStart=` / `now=` in the
  // goal the coordinator infers them from the model's clock and
  // historically picked next Monday — leaving /today and /calendar
  // empty until the following ISO week.
  const kickoffNow = new Date();
  const kickoffWeekStart = currentWeekStart(kickoffNow).toISOString();

  // Look up the active strategic path so the goal preamble can carry
  // week-1 post counts + per-channel reply budgets verbatim. Optional:
  // kickoff still fires if the path is missing (degenerate case at
  // launch — the goal degrades to "no plan to seed"). The schema has
  // only one path per user today, so a single SELECT with a
  // generatedAt tiebreak picks the latest after any future replan.
  const [activePath] = await db
    .select({
      id: strategicPaths.id,
      thesisArc: strategicPaths.thesisArc,
      channelMix: strategicPaths.channelMix,
    })
    .from(strategicPaths)
    .where(eq(strategicPaths.userId, userId))
    .orderBy(strategicPaths.generatedAt)
    .limit(1);
  const pathId = activePath?.id ?? null;

  // The goal preamble is the SOLE owner of kickoff dispatch logic
  // (per coordinator/AGENT.md "Goal-driven dispatch"). We pre-compute
  // the per-channel slot facts here — week-1 post counts via
  // derivePerWeekPosts, and per-channel repliesPerDay budgets — so the
  // coordinator can read concrete numbers off the goal instead of
  // inferring or querying.
  const goal = buildKickoffGoalText({
    productName: productRow.name,
    pathId,
    weekStart: kickoffWeekStart,
    now: kickoffNow.toISOString(),
    channels,
    week1Posts: activePath
      ? derivePerWeekPosts(
          activePath as Pick<StrategicPath, 'thesisArc' | 'channelMix'>,
          0,
        )
      : null,
    channelMix: (activePath?.channelMix ?? null) as Record<
      string,
      { repliesPerDay?: number | null } | null | undefined
    > | null,
  });

  let conversationId: string;
  try {
    conversationId = await createAutomationConversation(teamId, 'kickoff');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cause =
      err instanceof Error && err.cause
        ? err.cause instanceof Error
          ? err.cause.message
          : String(err.cause)
        : null;
    log.warn(
      `createAutomationConversation failed for kickoff team=${teamId}: ${message}${cause ? ` | cause: ${cause}` : ''}`,
    );
    return { fired: false, reason: 'enqueue_failed' };
  }

  void coordinator; // resolved for misconfiguration check; lead is the sole recipient
  // Founder-facing summary persisted into metadata.publicContent. The
  // redactor at the API boundary swaps this into `content` when serving
  // the row to the browser; the raw `goal` (with internal architecture
  // details — playbook, agent names, mode strings) stays server-side
  // for the lead's agent-run replay. See dispatchLeadMessage docs.
  const publicSummary = pathId
    ? `Building ${productRow.name}'s first-week plan and drafting your first reply candidates.`
    : `Building ${productRow.name}'s first-week plan.`;
  try {
    const { runId } = await dispatchLeadMessage(
      {
        teamId,
        conversationId,
        goal,
        publicSummary,
        trigger: 'kickoff',
      },
      db,
    );
    log.info(
      `kickoff dispatched user=${userId} team=${teamId} run=${runId} conv=${conversationId}`,
    );
    return { fired: true, runId, conversationId };
  } catch (err) {
    // Drizzle's Error.message renders only `Failed query: <SQL>\nparams: ...`
    // and stashes the postgres-side reason on `err.cause`. Without surfacing
    // the cause, every insert failure looks identical in the dev console
    // (truncated SQL + params, no clue why). Fold both sides into the warn
    // string so the next failure says e.g. `column "parent_tool_use_id" does
    // not exist` instead of leaving the operator to guess.
    const message = err instanceof Error ? err.message : String(err);
    const cause =
      err instanceof Error && err.cause
        ? err.cause instanceof Error
          ? err.cause.message
          : String(err.cause)
        : null;
    log.warn(
      `dispatchLeadMessage failed for kickoff team=${teamId}: ${message}${cause ? ` | cause: ${cause}` : ''}`,
    );
    return { fired: false, reason: 'enqueue_failed', conversationId };
  }
}

interface KickoffGoalArgs {
  productName: string;
  pathId: string | null;
  weekStart: string;
  now: string;
  channels: readonly string[];
  /** Week-1 per-channel post counts; null when no strategic path. */
  week1Posts: { x: number; reddit: number; email: number } | null;
  /** Channel-mix object (read raw — passthrough lets `repliesPerDay` survive). */
  channelMix: Record<
    string,
    { repliesPerDay?: number | null } | null | undefined
  > | null;
}

/**
 * Build the kickoff goal preamble. The coordinator reads this verbatim
 * — every spawn directive, every plan-item directive, every channel ×
 * mode pair lives here, not in AGENT.md. Adding a new channel = one
 * branch in this function.
 *
 * The goal is structured in three steps:
 *   1. Seed week-1 plan_items via add_plan_item (post + reply slots).
 *   2. Spawn ONE Task per (channel × mode) where slots exist for today,
 *      ALL IN THE SAME ASSISTANT TURN — engine accepts multiple tool_use
 *      blocks per turn so 4 parallel spawns is one round-trip.
 *   3. update_plan_item state='drafted' as <task-notification> arrives.
 *
 * Pairs with no slot are skipped silently — no spawn, no directive.
 * Reddit-only setups emit 2 spawns; X+Reddit emit up to 4.
 */
export function buildKickoffGoalText(args: KickoffGoalArgs): string {
  const { productName, pathId, weekStart, now, channels, week1Posts } = args;

  // Pathological at kickoff: onboarding writes a path before /team mounts.
  // Fall back to a minimal "no plan" goal so the coordinator just
  // acknowledges and tells the founder what's missing.
  if (!pathId || !week1Posts) {
    return (
      `First-visit kickoff for ${productName}. ` +
      `weekStart=${weekStart} now=${now}. ` +
      `Connected channels: ${channels.join(', ') || 'none'}. ` +
      `Trigger: kickoff. ` +
      `No active strategic path — acknowledge the founder and tell them ` +
      `to finish onboarding so the team can seed their plan.`
    );
  }

  // Per-channel reply budget. The strategic-path schema marks
  // `repliesPerDay` as nullish; coerce to 0 when missing.
  const repliesX = readRepliesPerDay(args.channelMix, 'x');
  const repliesReddit = readRepliesPerDay(args.channelMix, 'reddit');

  const xConnected = channels.includes('x');
  const redditConnected = channels.includes('reddit');

  // Build the spawn directives. Each (channel, mode) pair becomes one
  // line in the goal IF the slot exists for today — pairs with zero
  // budget are silently dropped so the coordinator doesn't spawn
  // empty work.
  const spawns: string[] = [];
  if (xConnected && repliesX > 0) {
    spawns.push(
      `- (x, reply): Task({ subagent_type: 'social-media-manager', description: 'fill x reply slot', prompt: 'Mode: discover-and-fill-slot\\nplanItemId: <today's x content_reply uuid>\\ntargetCount: ${repliesX}' })`,
    );
  }
  if (redditConnected && repliesReddit > 0) {
    spawns.push(
      `- (reddit, reply): Task({ subagent_type: 'social-media-manager', description: 'fill reddit reply slot', prompt: 'Mode: discover-and-fill-slot\\nplanItemId: <today's reddit content_reply uuid>\\ntargetCount: ${repliesReddit}' })`,
    );
  }
  if (xConnected && week1Posts.x > 0) {
    spawns.push(
      `- (x, post): Task({ subagent_type: 'social-media-manager', description: 'draft x post batch', prompt: 'Mode: post-batch\\nplanItemIds: <today's x content_post uuids>' })`,
    );
  }
  if (redditConnected && week1Posts.reddit > 0) {
    spawns.push(
      `- (reddit, post): Task({ subagent_type: 'social-media-manager', description: 'draft reddit post batch', prompt: 'Mode: post-batch\\nplanItemIds: <today's reddit content_post uuids>' })`,
    );
  }

  const channelsLine = channels.join(', ') || 'none';
  const lines: string[] = [
    `First-visit kickoff for ${productName}.`,
    `Strategic path pathId=${pathId}.`,
    `weekStart=${weekStart} now=${now}.`,
    `Connected channels: ${channelsLine}.`,
    `Trigger: kickoff.`,
    ``,
    `Week-1 budget (read off the strategic path):`,
    `- x: ${week1Posts.x} posts/week, ${repliesX} replies/day`,
    `- reddit: ${week1Posts.reddit} posts/week, ${repliesReddit} replies/day`,
    ``,
    `Step 1 — Seed week-1 plan_items via add_plan_item (one call per row).`,
    `For each channel above with posts/week > 0: add that many content_post rows for week 1, anchored to scheduledAt within this week's UTC days using preferredHours from channelMix.`,
    `For each channel with replies/day > 0: add one content_reply row per day for week 1 with params.targetCount = repliesPerDay.`,
    `Pass weekStart=${weekStart} and now=${now} verbatim — never let scheduledAt fall before now.`,
    ``,
  ];

  if (spawns.length > 0) {
    lines.push(
      `Step 2 — Dispatch all of the following Task spawns IN A SINGLE ASSISTANT TURN (engine accepts multiple tool_use blocks per turn — parallelize). Reply slots use the planItemId you just added in step 1; post batches use the same-day content_post uuids:`,
      ...spawns,
      ``,
      `Step 3 — As each <task-notification> arrives, call update_plan_item({ id: <touched uuid>, state: 'drafted' }) for the slot(s) that task drafted for. Don't wait for all to return before updating the first.`,
    );
  } else {
    lines.push(
      `Step 2 — No connected channels with active reply or post budget. Skip dispatch and tell the founder which channel they should connect to start drafting.`,
    );
  }

  return lines.join('\n');
}

function readRepliesPerDay(
  channelMix: KickoffGoalArgs['channelMix'],
  ch: 'x' | 'reddit',
): number {
  if (!channelMix) return 0;
  const entry = channelMix[ch];
  if (!entry) return 0;
  const v = entry.repliesPerDay;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}
