/**
 * Helpers for reading allocations off a `StrategicPath` jsonb row.
 *
 * Per-week per-channel post allocation lives on `thesisArc[i].posts`.
 * This module is the SINGLE place that knows how to pull a specific
 * week's allocation out — including the legacy fallback to
 * `channelMix.{ch}.perWeek` for paths generated before per-week posts
 * existed.
 */

import type { StrategicPath, StrategicThesisWeekPosts } from '@/lib/strategic-path-schema';

/**
 * Resolve the post allocation for a given week, defaulting any missing
 * channel to 0. Returns a fresh object on every call — never mutates
 * the input path.
 *
 * Resolution order:
 *   1. `path.thesisArc[weekIndex].posts.{ch}` (new shape)
 *   2. Legacy `path.channelMix.{ch}.perWeek` if present (uniform across
 *      every week — same value for week 0 and week 5)
 *   3. 0
 *
 * `weekIndex` outside the thesis arc returns all zeros (no negative
 * indices, no past-end indices — the caller is responsible for
 * clamping).
 */
export function derivePerWeekPosts(
  path: Pick<StrategicPath, 'thesisArc' | 'channelMix'>,
  weekIndex: number,
): { x: number; reddit: number; email: number } {
  const week = path.thesisArc[weekIndex];
  const fromArc = (week as { posts?: StrategicThesisWeekPosts } | undefined)
    ?.posts;
  if (fromArc) {
    return {
      x: fromArc.x ?? 0,
      reddit: fromArc.reddit ?? 0,
      email: fromArc.email ?? 0,
    };
  }
  // Legacy: paths generated before per-week posts had a single
  // `perWeek` on the channel-mix object that applied to every week.
  const legacyMix = (path.channelMix ?? {}) as Record<
    string,
    { perWeek?: number } | null | undefined
  >;
  return {
    x: Number(legacyMix.x?.perWeek ?? 0),
    reddit: Number(legacyMix.reddit?.perWeek ?? 0),
    email: Number(legacyMix.email?.perWeek ?? 0),
  };
}

/**
 * Sum a single channel's posts across the entire thesis arc — the
 * "total posts in this plan window" the founder sees in the quota
 * footer.
 */
export function sumChannelPostsAcrossArc(
  path: Pick<StrategicPath, 'thesisArc' | 'channelMix'>,
  channel: 'x' | 'reddit' | 'email',
): number {
  let total = 0;
  for (let i = 0; i < path.thesisArc.length; i += 1) {
    total += derivePerWeekPosts(path, i)[channel];
  }
  return total;
}
