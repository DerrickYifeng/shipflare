/**
 * Platform configuration registry.
 *
 * Single source of truth for per-platform defaults. Adding a new channel
 * (LinkedIn, Mastodon, HN, etc.) means adding one entry here — zero changes
 * to processors, routes, or core pipelines.
 */

/**
 * Kind of content being written/validated. Most platforms have different
 * caps for a standalone post vs. a reply (Reddit: 40k vs 10k). On X, both
 * kinds share the same 280 platform cap; stylistic reply targets ("aim for
 * 40-140 chars") live in agent prose, not as platform limits.
 */
export type ContentKind = 'post' | 'reply';

export interface PlatformCharLimits {
  post: number;
  reply: number;
}

export interface PlatformConfig {
  /** Unique identifier used in DB, queue jobs, and routing. */
  id: string;
  /** Human-readable name for UI display. */
  displayName: string;
  /**
   * Whether this platform is enabled for the current product release.
   * Set to `false` to hide the platform from onboarding, settings, landing,
   * and any `listAvailablePlatforms()` fan-out without tearing out the
   * workers, schema, or client code that still reference it. The MVP ships
   * X only; Reddit flips back to `true` once the channel is re-opened.
   */
  enabled: boolean;
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
  /**
   * Character limit for this platform, broken down by content kind so the
   * validator pipeline and UI can pull the right cap without hardcoding.
   * Both `post` and `reply` are the platform's hard ceiling — stylistic
   * targets (e.g. "aim for 40-140 chars on a reply") live in agent prose,
   * not here, because they're editorial rather than platform-enforced.
   */
  maxCharLength: PlatformCharLimits;
  /**
   * @deprecated Use `maxCharLength.post` / `maxCharLength.reply` or
   * `getPlatformCharLimits()`. Retained so any external caller that still
   * reads this field keeps compiling until it migrates.
   */
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
    // MVP ships X-only. Flip to `true` to re-enable Reddit across the product.
    enabled: false,
    defaultSources: ['SideProject', 'startups', 'webdev'],
    sourceLabel: 'subreddit',
    sourcePrefix: 'r/',
    replyWindowMinutes: 60,
    maxCharLength: { post: 40_000, reply: 10_000 },
    charLimit: 10_000,
    supportsAnonymousRead: true,
    // Reddit IDs are base-36 — letters + digits. No stable discriminator regex.
    buildContentUrl: (_username, contentId) =>
      `https://reddit.com/comments/${contentId}`,
  },
  x: {
    id: 'x',
    displayName: 'X (Twitter)',
    enabled: true,
    defaultSources: ['SaaS', 'startup tools', 'indie hacker'],
    envGuard: 'XAI_API_KEY',
    sourceLabel: 'topic',
    replyWindowMinutes: 15,
    // Both posts and replies share X's 280-char platform cap. Twitter
    // applies weighted counting (URLs = 23, emoji = 2, CJK = 2) — the
    // length validator uses `twitter-text.parseTweet` so this number is
    // measured against the same algorithm X enforces.
    maxCharLength: { post: 280, reply: 280 },
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
 * Check whether a platform is registered, enabled for this release, AND has
 * its env guard satisfied. The `enabled` flag is the product-level switch;
 * `envGuard` is the deployment-level switch. Both must pass.
 */
export function isPlatformAvailable(platform: string): boolean {
  const config = PLATFORMS[platform];
  if (!config) return false;
  if (config.enabled === false) return false;
  if (!config.envGuard) return true;
  return !!process.env[config.envGuard];
}

/**
 * List all known platform IDs (regardless of enabled / env state). Use this
 * when you need the full registry — e.g. validator sibling-platform lookup.
 */
export function listPlatforms(): string[] {
  return Object.keys(PLATFORMS);
}

/**
 * List platforms that are registered, enabled, and have their env guard
 * satisfied — i.e. safe to surface in UI and fan out to.
 */
export function listAvailablePlatforms(): string[] {
  return listPlatforms().filter(isPlatformAvailable);
}

/**
 * Get the character limit for a platform + content kind. Throws on unknown
 * platform so callers fail loud instead of silently writing past X's 280.
 */
export function getPlatformCharLimits(
  platform: string,
  kind: ContentKind,
): number {
  const config = getPlatformConfig(platform);
  return config.maxCharLength[kind];
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
