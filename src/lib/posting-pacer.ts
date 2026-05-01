import { db } from '@/lib/db';
import { posts } from '@/lib/db/schema';
import { and, eq, gte } from 'drizzle-orm';
import { PLATFORMS, type PostingConfig, type PostingTier } from '@/lib/platform-config';

export type PostKind = 'reply' | 'post';

export interface SlotInput {
  userId: string;
  platform: string;
  kind: PostKind;
  /** Days since channels.connectedAt for this user+platform. */
  connectedAgeDays: number;
  /** Override `now()` — used by tests + the deferral recursion. */
  now?: Date;
}

export type SlotResult =
  | {
      deferred: false;
      delayMs: number;
      reason: 'immediate' | 'spaced' | 'quiet_hours';
    }
  | {
      deferred: true;
      reason: 'over_daily_cap' | 'no_pacer_config';
      /** ms until the pacer suggests retrying. 0 if unknown. */
      delayMs: number;
    };

/**
 * Inject the recent-posts source so unit tests can avoid a live DB. Production
 * code never calls this — `computeNextSlot` falls back to the real DB query.
 */
let recentPostsSource: ((args: {
  userId: string;
  platform: string;
  sinceMs: number;
}) => Promise<Array<{ postedAt: Date; kind: PostKind }>>) | null = null;

export function __setRecentPostsSourceForTests(
  fn: typeof recentPostsSource,
): void {
  recentPostsSource = fn;
}

function pickTier(config: PostingConfig, ageDays: number): PostingTier {
  // Tiers are ordered ascending by minAgeDays; iterate from the end so the
  // highest matching tier wins (e.g. ageDays=60 picks minAgeDays=30, not 0).
  for (let i = config.tiers.length - 1; i >= 0; i--) {
    if (ageDays >= config.tiers[i].minAgeDays) return config.tiers[i];
  }
  return config.tiers[0];
}

function isQuietHour(now: Date, [startHour, endHour]: [number, number]): boolean {
  const h = now.getUTCHours();
  if (startHour <= endHour) return h >= startHour && h < endHour;
  // Wraps midnight (e.g. [22, 4])
  return h >= startHour || h < endHour;
}

function nextActiveBoundary(now: Date, [, endHour]: [number, number]): Date {
  // Quiet window ends at endHour UTC today; if we're already past it, tomorrow.
  const out = new Date(now);
  out.setUTCMinutes(0, 0, 0);
  if (out.getUTCHours() >= endHour) out.setUTCDate(out.getUTCDate() + 1);
  out.setUTCHours(endHour, 0, 0, 0);
  return out;
}

function jitter(seconds: number, plusMinusSec: number): number {
  const offset = (Math.random() * 2 - 1) * plusMinusSec;
  return Math.max(0, (seconds + offset) * 1000);
}

export async function computeNextSlot(input: SlotInput): Promise<SlotResult> {
  const config = PLATFORMS[input.platform]?.posting;
  if (!config) {
    return { deferred: true, reason: 'no_pacer_config', delayMs: 0 };
  }

  const tier = pickTier(config, input.connectedAgeDays);
  const now = input.now ?? new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const sinceMs = now.getTime() - dayMs;

  const recent = await (recentPostsSource
    ? recentPostsSource({ userId: input.userId, platform: input.platform, sinceMs })
    : fetchRecentPosts(input.userId, input.platform, new Date(sinceMs)));

  const counts = recent.reduce(
    (acc, r) => {
      acc[r.kind] += 1;
      return acc;
    },
    { reply: 0, post: 0 } as Record<PostKind, number>,
  );

  const cap = input.kind === 'reply' ? tier.maxRepliesPerDay : tier.maxPostsPerDay;
  if (counts[input.kind] >= cap) {
    // Defer to when the oldest contributing post rolls off the 24h window.
    const oldest = recent
      .filter((r) => r.kind === input.kind)
      .reduce((min, r) => (r.postedAt < min ? r.postedAt : min), now);
    const rollOffMs = oldest.getTime() + dayMs - now.getTime();
    return { deferred: true, reason: 'over_daily_cap', delayMs: Math.max(rollOffMs, 0) };
  }

  // Spacing relative to most-recent post of any kind.
  const lastPost = recent.reduce<Date | null>(
    (latest, r) => (latest == null || r.postedAt > latest ? r.postedAt : latest),
    null,
  );

  // Apply jitter to the spacing delay. When there's no prior post, earliestNext
  // equals `now`, so delayMs falls through to 0 → 'immediate'.
  const earliestNext = lastPost
    ? new Date(lastPost.getTime() + jitter(tier.minSpacingSec, tier.jitterSec))
    : now;

  // Quiet hours: push to next active window. Check against earliestNext so a
  // spaced post that lands in quiet hours also gets pushed correctly.
  if (isQuietHour(earliestNext, config.quietHoursUTC)) {
    const boundary = nextActiveBoundary(earliestNext, config.quietHoursUTC);
    const jittered = boundary.getTime() + jitter(0, tier.jitterSec);
    return {
      deferred: false,
      reason: 'quiet_hours',
      delayMs: Math.max(0, jittered - now.getTime()),
    };
  }

  const delayMs = Math.max(0, earliestNext.getTime() - now.getTime());
  return {
    deferred: false,
    reason: delayMs === 0 ? 'immediate' : 'spaced',
    delayMs,
  };
}

async function fetchRecentPosts(
  userId: string,
  platform: string,
  since: Date,
): Promise<Array<{ postedAt: Date; kind: PostKind }>> {
  const rows = await db
    .select({ postedAt: posts.postedAt, draftId: posts.draftId })
    .from(posts)
    .where(
      and(
        eq(posts.userId, userId),
        eq(posts.platform, platform),
        gte(posts.postedAt, since),
      ),
    );
  // NOTE: The `posts` table has no `kind` column as of this writing.
  // Conservatively treating all rows as 'reply' overcounts against
  // maxRepliesPerDay — the safe side of the tradeoff (defer too aggressively
  // rather than too liberally). Refine when a `kind` column is added.
  return rows.map((r) => ({ postedAt: r.postedAt, kind: 'reply' as const }));
}
