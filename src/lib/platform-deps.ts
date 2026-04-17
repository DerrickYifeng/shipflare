/**
 * Platform dependency factory.
 *
 * Centralizes client instantiation so processors don't need
 * if/else blocks per platform. Adding a new platform means
 * adding one case here — no changes to any processor.
 */

import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { RedditClient } from '@/lib/reddit-client';
import { XAIClient } from '@/lib/xai-client';
import { XClient } from '@/lib/x-client';
import { PLATFORMS } from '@/lib/platform-config';

/**
 * Create platform-specific dependencies for a user.
 *
 * Returns a Record to inject into `runSkill({ deps })`.
 * Throws if a required channel is missing.
 */
export async function createPlatformDeps(
  platform: string,
  userId: string,
): Promise<Record<string, unknown>> {
  // Explicit projection — this is the only sanctioned path where
  // oauth tokens are read out of the DB (see CLAUDE.md → Security TODO).
  const [channel] = await db
    .select({
      id: channels.id,
      platform: channels.platform,
      oauthTokenEncrypted: channels.oauthTokenEncrypted,
      refreshTokenEncrypted: channels.refreshTokenEncrypted,
      tokenExpiresAt: channels.tokenExpiresAt,
    })
    .from(channels)
    .where(and(eq(channels.userId, userId), eq(channels.platform, platform)))
    .limit(1);

  switch (platform) {
    case 'reddit': {
      if (!channel) throw new Error('No Reddit channel connected');
      return { redditClient: RedditClient.fromChannel(channel) };
    }
    case 'x': {
      return {
        xaiClient: new XAIClient(),
        ...(channel ? { xClient: XClient.fromChannel(channel) } : {}),
      };
    }
    default:
      return {};
  }
}

/**
 * Build a platform client directly from an already-loaded channel row.
 *
 * Used by processors that look up a channel by id (not by userId), such as
 * `posting.ts`, where the queue job carries a specific `channelId`. The
 * caller is responsible for using an explicit projection that includes the
 * token columns — see CLAUDE.md → "Security TODO" for the allowlist.
 *
 * Returns `null` for platforms that don't have an OAuth client so callers
 * can decide whether to proceed.
 */
export function createClientFromChannel(
  platform: string,
  channel: {
    id: string;
    oauthTokenEncrypted: string;
    refreshTokenEncrypted: string;
    tokenExpiresAt: Date | null;
  },
): RedditClient | XClient | null {
  switch (platform) {
    case 'reddit':
      return RedditClient.fromChannel(channel);
    case 'x':
      return XClient.fromChannel(channel);
    default:
      return null;
  }
}

/**
 * Create read-only / anonymous platform deps for public endpoints.
 *
 * Used by `/api/scan` and CLI scripts that run before any channel is
 * connected. Only instantiates clients for platforms whose config sets
 * `supportsAnonymousRead` and whose env guard (if any) is satisfied.
 * Never touches `channels.oauth_token_encrypted` — no user identity in
 * scope.
 */
export function createPublicPlatformDeps(
  platforms?: string[],
): Record<string, unknown> {
  const deps: Record<string, unknown> = {};
  const ids = platforms ?? Object.keys(PLATFORMS);

  for (const id of ids) {
    const config = PLATFORMS[id];
    if (!config || !config.supportsAnonymousRead) continue;
    if (config.envGuard && !process.env[config.envGuard]) continue;

    switch (id) {
      case 'reddit':
        deps.redditClient = RedditClient.appOnly();
        break;
      case 'x':
        deps.xaiClient = new XAIClient();
        break;
      // New anonymous-capable platforms add their factory here.
    }
  }

  return deps;
}
