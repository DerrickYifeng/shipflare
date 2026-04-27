import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { isPlatformAvailable } from '@/lib/platform-config';

/**
 * Return the distinct, currently-available platforms a user has connected
 * as channels. Filters out platforms that are disabled in `platform-config`
 * or missing their env guard (so Reddit doesn't leak into planner fan-out
 * when the API keys aren't configured in this environment).
 *
 * Used by:
 *   - POST /api/onboarding/commit  — seed discovery + calibration per channel
 *   - POST /api/product/phase      — feed the strategic/tactical planner
 *                                    real channels instead of a hardcoded list
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
  return [...new Set(rows.map((r) => r.platform))].filter(isPlatformAvailable);
}
