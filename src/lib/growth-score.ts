import type { ChannelTarget } from './growth-targets';

export interface ChannelCounts {
  threads: number;
  drafts: number;
  posts: number;
  replies: number;
}

/**
 * Per-channel score (0-100). Each component is capped at 1.0 before averaging
 * so over-performing on one metric (e.g. threads spam) can never compensate
 * for zero on another.
 */
export function channelScore(counts: ChannelCounts, target: ChannelTarget): number {
  const cThreads = Math.min(1, counts.threads / target.threads);
  const cDrafts = Math.min(1, counts.drafts / target.drafts);
  const cPosts = Math.min(1, counts.posts / target.posts);
  const cReplies = Math.min(1, counts.replies / target.replies);
  return Math.round((100 * (cThreads + cDrafts + cPosts + cReplies)) / 4);
}

/** Module = arithmetic mean of enabled-channel scores (rounded). */
export function moduleScore(channelScores: number[]): number {
  if (channelScores.length === 0) return 0;
  const sum = channelScores.reduce((a, b) => a + b, 0);
  return Math.round(sum / channelScores.length);
}

/** Overall = sum(score × weight) across live modules. Empty list → 0. */
export function overallScore(modules: { score: number; weight: number }[]): number {
  if (modules.length === 0) return 0;
  return Math.round(modules.reduce((acc, m) => acc + m.score * m.weight, 0));
}
