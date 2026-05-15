/**
 * Per-platform 7-day activity targets driving the Growth page health score.
 *
 * Each `ChannelTarget` field is the count that maps to "this metric is firing
 * at 100%". The score formula caps each component at 1.0 before averaging,
 * so blasting `threads` past 30 on X doesn't compensate for zero `posts`.
 *
 * These are first-cut numbers; tune empirically once we have ≥2 weeks of
 * rollup data per cohort.
 */
export interface ChannelTarget {
  threads: number;
  drafts: number;
  posts: number;
  replies: number;
}

export const GROWTH_TARGETS: Record<string, ChannelTarget> = {
  x: { threads: 30, drafts: 20, posts: 5, replies: 15 },
  reddit: { threads: 15, drafts: 10, posts: 3, replies: 8 },
};

export function getChannelTarget(platform: string): ChannelTarget | undefined {
  return GROWTH_TARGETS[platform];
}
