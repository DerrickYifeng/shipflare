import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { isPlatformAvailable } from '@/lib/platform-config';

/**
 * Return the distinct, currently-available platforms a user has access to.
 *
 * Two sources merged:
 *   1. Rows in the `channels` table (OAuth-bound channels, e.g. X)
 *   2. Always-on no-binding channels (Reddit) — these never write a
 *      `channels` row but every user can dispatch to them via the
 *      handoff pipeline.
 *
 * The result is filtered through `isPlatformAvailable` so disabled or
 * env-guard-missing platforms are dropped (Reddit drops out in
 * environments where its API keys / app-only token aren't configured).
 *
 * Used by:
 *   - POST /api/onboarding/commit  — seed discovery + calibration per channel
 *   - POST /api/product/phase      — feed the strategic/tactical planner
 *                                    real channels instead of a hardcoded list
 *   - team-kickoff / team-daily    — decide which (channel × mode) pairs
 *                                    to spawn social-media-manager for
 *
 * Explicit projection — never select token columns. See CLAUDE.md "Only the
 * three helpers in platform-deps.ts … are allowed to read
 * channels.oauth_token_encrypted".
 */
export async function getUserChannels(userId: string): Promise<string[]> {
  const rows = await db
    .select({ platform: channels.platform })
    .from(channels)
    .where(eq(channels.userId, userId));
  // Reddit is a no-binding always-on channel — never has a row in the
  // channels table but is available to every user. Per the 2026-05-07
  // binding-removal pivot. The `isPlatformAvailable` filter still gates
  // it, so deployments without Reddit env vars correctly drop it.
  const dbPlatforms = rows.map((r) => r.platform);
  return [...new Set([...dbPlatforms, 'reddit'])].filter(isPlatformAvailable);
}
