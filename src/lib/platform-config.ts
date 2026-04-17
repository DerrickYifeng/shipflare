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
  /**
   * Whether the platform supports read-only / anonymous discovery
   * (e.g. Reddit public JSON, xAI Grok search). Drives `createPublicPlatformDeps()`.
   */
  supportsAnonymousRead?: boolean;
  /**
   * Regex that matches this platform's external IDs. Used only for legacy
   * records where the `platform` column isn't joined through. Prefer
   * `threads.platform` / `posts.platform` for routing whenever possible.
   */
  externalIdPattern?: RegExp;
  /** Builds a user-facing URL for a piece of content on this platform. */
  buildContentUrl?: (username: string, contentId: string) => string;
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
    supportsAnonymousRead: true,
    // Reddit IDs are base-36 — letters + digits. No stable discriminator regex.
    buildContentUrl: (_username, contentId) =>
      `https://reddit.com/comments/${contentId}`,
  },
  x: {
    id: 'x',
    displayName: 'X (Twitter)',
    defaultSources: ['SaaS', 'startup tools', 'indie hacker'],
    envGuard: 'XAI_API_KEY',
    sourceLabel: 'topic',
    replyWindowMinutes: 15,
    charLimit: 280,
    supportsAnonymousRead: true,
    // X/Twitter tweet IDs are purely numeric (snowflake IDs).
    externalIdPattern: /^\d+$/,
    buildContentUrl: (username, contentId) =>
      `https://x.com/${username}/status/${contentId}`,
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
 * List all known platform IDs.
 */
export function listPlatforms(): string[] {
  return Object.keys(PLATFORMS);
}

/**
 * List platforms that are both known and have their env guard satisfied.
 */
export function listAvailablePlatforms(): string[] {
  return listPlatforms().filter(isPlatformAvailable);
}

/**
 * Build a user-facing content URL from platform + username + content ID.
 * Looks up the per-platform `buildContentUrl` hook; falls back to `contentId`
 * for unknown platforms so callers don't need to null-check.
 */
export function buildContentUrl(
  platform: string,
  username: string,
  contentId: string,
): string {
  const config = PLATFORMS[platform];
  return config?.buildContentUrl?.(username, contentId) ?? contentId;
}
