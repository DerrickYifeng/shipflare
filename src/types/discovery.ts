/**
 * Unified discovery result type — platform-agnostic.
 *
 * Used across scan API responses, ThoughtStream, DiscoveryCard,
 * and dashboard feeds. Platform-specific fields live in `metadata`.
 */

export type DiscoverySource = 'reddit' | 'hackernews' | 'web' | 'producthunt' | 'x';

export interface IntentClassification {
  contentType: string;
  buyerStage: string;
  posterNeed: { present: boolean; type: string | null; strength: number };
  readerNeed: { present: boolean; strength: number };
  overall: number;
  reason?: string;
}

export interface ScoreDimensions {
  relevance: number;
  intent: number;
  exposure: number;
  freshness: number;
  engagement: number;
}

export interface DiscoveryResult {
  source: DiscoverySource;
  externalId: string;
  title: string;
  url: string;

  /** Platform-agnostic community label: "r/SideProject", "HN", "dev.to" */
  community: string;
  /** Weighted composite score 0-100 */
  score: number;
  postedAt: string;

  /** AI-generated reason why this thread is relevant */
  reason?: string;

  /** Platform-specific metadata */
  metadata: {
    upvotes?: number;
    commentCount?: number;
    points?: number;
    domain?: string;
    author?: string;
  };

  /** Multi-dimensional score breakdown */
  dimensions?: ScoreDimensions;

  /** Three-layer intent classification */
  intent?: IntentClassification;
}

/** A community discovered by the scout agent. */
export interface DiscoveredCommunity {
  name: string;
  subscribers?: number;
  audienceFit: number;
  reason: string;
}

/**
 * Legacy scan result shape from the current API.
 * Components accept this and map to DiscoveryResult internally.
 */
export interface LegacyScanResult {
  source: string;
  externalId: string;
  title: string;
  url: string;
  subreddit: string;
  upvotes: number;
  commentCount: number;
  relevanceScore: number;
  scores?: ScoreDimensions;
  postedAt: string;
  reason?: string;
}

/** Map a legacy scan result to the unified DiscoveryResult shape. */
export function toLegacyDiscoveryResult(r: LegacyScanResult): DiscoveryResult {
  return {
    source: r.source as DiscoverySource,
    externalId: r.externalId,
    title: r.title,
    url: r.url,
    community: `r/${r.subreddit}`,
    score: r.relevanceScore,
    postedAt: r.postedAt,
    reason: r.reason,
    metadata: {
      upvotes: r.upvotes,
      commentCount: r.commentCount,
    },
    dimensions: r.scores,
  };
}
