/**
 * Platform configuration registry.
 *
 * Single source of truth for per-platform defaults. Adding a new channel
 * (LinkedIn, Mastodon, HN, etc.) means adding one entry here — zero changes
 * to processors, routes, or core pipelines.
 */

export interface PlatformConfig {
  /** Unique identifier used in DB, queue jobs, and routing. */
  id: string;
  /** Human-readable name for UI display. */
  displayName: string;
  /** Fallback discovery sources when a user hasn't configured their own. */
  defaultSources: string[];
  /** Env var that must be set for this platform to be available. */
  envGuard?: string;
  /** Label for a single source (shown in UI / logs). */
  sourceLabel: string;
  /** Display prefix for source names (e.g. "r/" for Reddit). */
  sourcePrefix?: string;
  /** Default reply window in minutes for the monitor pipeline. */
  replyWindowMinutes?: number;
  /** Character limit for replies on this platform. */
  charLimit?: number;
}

export const PLATFORMS: Record<string, PlatformConfig> = {
  reddit: {
    id: 'reddit',
    displayName: 'Reddit',
    defaultSources: ['SideProject', 'startups', 'webdev'],
    sourceLabel: 'subreddit',
    sourcePrefix: 'r/',
    replyWindowMinutes: 60,
    charLimit: 10_000,
  },
  x: {
    id: 'x',
    displayName: 'X (Twitter)',
    defaultSources: ['SaaS', 'startup tools', 'indie hacker'],
    envGuard: 'XAI_API_KEY',
    sourceLabel: 'topic',
    replyWindowMinutes: 15,
    charLimit: 280,
  },
};

/**
 * Get config for a platform, throwing if unknown.
 */
export function getPlatformConfig(platform: string): PlatformConfig {
  const config = PLATFORMS[platform];
  if (!config) throw new Error(`Unknown platform: ${platform}`);
  return config;
}

/**
 * Check whether a platform's required env var is set.
 */
export function isPlatformAvailable(platform: string): boolean {
  const config = PLATFORMS[platform];
  if (!config) return false;
  if (!config.envGuard) return true;
  return !!process.env[config.envGuard];
}

/**
 * Build a user-facing content URL from platform + username + content ID.
 */
export function buildContentUrl(
  platform: string,
  username: string,
  contentId: string,
): string {
  switch (platform) {
    case 'x':
      return `https://x.com/${username}/status/${contentId}`;
    case 'reddit':
      return `https://reddit.com/comments/${contentId}`;
    default:
      return contentId;
  }
}
