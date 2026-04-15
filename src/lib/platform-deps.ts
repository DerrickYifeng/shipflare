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
  const [channel] = await db
    .select()
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
