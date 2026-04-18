import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { channels } from '@/lib/db/schema';
import { isPlatformAvailable } from '@/lib/platform-config';

export const dynamic = 'force-dynamic';

/**
 * List the caller's connected channels. Used by the UI to fan out per-platform
 * state (buttons, pipeline widgets, settings rows) from one request.
 *
 * Explicit projection — NEVER selects `oauth_token_encrypted` /
 * `refresh_token_encrypted`. Per CLAUDE.md "Security TODO", only the three
 * helpers in `src/lib/platform-deps.ts` are allowed to read those columns.
 *
 * Filters via `isPlatformAvailable` so rows for platforms that are disabled
 * at the product level (or missing their env guard) stay hidden from UI
 * fan-out while the underlying `channels` row persists.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rows = await db
    .select({
      id: channels.id,
      platform: channels.platform,
      username: channels.username,
    })
    .from(channels)
    .where(eq(channels.userId, session.user.id));

  const available = rows.filter((r) => isPlatformAvailable(r.platform));

  return NextResponse.json({ channels: available });
}
