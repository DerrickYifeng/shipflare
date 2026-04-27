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
import { MemoryStore } from '@/memory/store';

/**
 * Create platform-specific dependencies for a user.
 *
 * Returns a Record to inject as a ToolContext dep bag for
 * `runAgent(...)`. Throws if a required channel is missing.
 *
 * When `productId` is provided, the returned bag also includes a
 * scoped `memoryStore` — discovery v3 (scout + reviewer) needs it
 * to read the onboarding rubric and write reviewer-disagreement
 * logs. Existing callers that omit `productId` see no change.
 */
export async function createPlatformDeps(
  platform: string,
  userId: string,
  productId?: string,
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

  const memoryDeps: Record<string, unknown> = productId
    ? { memoryStore: new MemoryStore(userId, productId) }
    : {};

  switch (platform) {
    case 'reddit': {
      if (!channel) throw new Error('No Reddit channel connected');
      return {
        redditClient: RedditClient.fromChannel(channel),
        ...memoryDeps,
      };
    }
    case 'x': {
      return {
        xaiClient: new XAIClient(),
        ...(channel ? { xClient: XClient.fromChannel(channel) } : {}),
        ...memoryDeps,
      };
    }
    default:
      return memoryDeps;
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
 * Look up a channel by id, then build the platform client. Use when a caller
 * has a channel id (e.g. a BullMQ job payload carrying channelId) and wants
 * to stay out of the token-column read path — this helper does the SELECT
 * internally so the caller never touches oauth_token_encrypted /
 * refresh_token_encrypted directly.
 *
 * Returns { client, platform } on success, null if the channel doesn't exist
 * or its platform has no OAuth client. Callers decide whether a null is fatal.
 */
export async function createClientFromChannelById(
  channelId: string,
): Promise<{ client: RedditClient | XClient; platform: string } | null> {
  const [channel] = await db
    .select({
      id: channels.id,
      platform: channels.platform,
      oauthTokenEncrypted: channels.oauthTokenEncrypted,
      refreshTokenEncrypted: channels.refreshTokenEncrypted,
      tokenExpiresAt: channels.tokenExpiresAt,
    })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  if (!channel) return null;

  const client = createClientFromChannel(channel.platform, channel);
  if (!client) return null;

  return { client, platform: channel.platform };
}

/**
 * Aggregate platform deps for a team-run's ToolContext.
 *
 * Loads every platform client the team could need in one pass so the
 * ToolContext's synchronous `get(key)` lookup can serve them without
 * fanning out DB queries per tool call:
 *
 *   - `xaiClient` — always instantiated when `XAI_API_KEY` is set
 *     (Grok search is env-gated, not channel-gated). Specialists like
 *     `discovery-agent` read this for `xai_find_customers`.
 *   - `redditClient` / `xClient` — instantiated for every platform the
 *     user has connected a channel for. Skipped silently when the
 *     channel is missing or the token decrypt fails; the per-tool error
 *     ("Missing dependency: xClient") will surface downstream for the
 *     specialist to decide whether to abort or skip.
 *   - `memoryStore` — scoped to `(userId, productId)` when a product
 *     exists. Needed for specialists that read agent memory mid-run.
 *
 * Returns a plain Record so the caller can spread it into its own
 * get-switch or Map. Never throws — a missing dep surfaces at the
 * tool-execution boundary, not here.
 */
export async function createTeamPlatformDeps(
  userId: string,
  productId: string | null,
): Promise<Record<string, unknown>> {
  const deps: Record<string, unknown> = {};

  if (process.env.XAI_API_KEY) {
    try {
      deps.xaiClient = new XAIClient();
    } catch {
      // Key present but invalid — fall through; xai_find_customers will
      // raise its own clearer error.
    }
  }

  // Load every channel the user owns in one query — explicit projection
  // includes token columns (the project-wide security guard allows this
  // helper to read them; see CLAUDE.md Security TODO).
  const userChannels = await db
    .select({
      id: channels.id,
      platform: channels.platform,
      oauthTokenEncrypted: channels.oauthTokenEncrypted,
      refreshTokenEncrypted: channels.refreshTokenEncrypted,
      tokenExpiresAt: channels.tokenExpiresAt,
    })
    .from(channels)
    .where(eq(channels.userId, userId));

  for (const ch of userChannels) {
    try {
      const client = createClientFromChannel(ch.platform, ch);
      if (!client) continue;
      if (ch.platform === 'reddit') deps.redditClient = client;
      if (ch.platform === 'x') deps.xClient = client;
    } catch {
      // Corrupt row / expired token — skip so one broken channel
      // doesn't block sibling clients.
    }
  }

  if (productId) {
    deps.memoryStore = new MemoryStore(userId, productId);
  }

  return deps;
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
