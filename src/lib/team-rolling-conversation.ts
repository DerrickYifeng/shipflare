// Resolves a stable per-team conversation by title (e.g. 'Discovery'),
// creating it on first call. Used by recurring automation team-runs that
// should bump an existing rolling conversation rather than spawning a
// new one every cron tick.
//
// Distinct from `createAutomationConversation` (lib/team-conversation-helpers):
// that helper always mints a fresh row with a timestamped title — correct
// for single-shot bundles like a Monday weekly replan. This helper is for
// the daily-discovery case where we want one persistent thread the user
// can pin / scroll back through.

import { and, desc, eq } from 'drizzle-orm';
import { db as defaultDb, type Database } from '@/lib/db';
import { teamConversations } from '@/lib/db/schema';

export async function resolveRollingConversation(
  teamId: string,
  title: string,
  db: Database = defaultDb,
): Promise<string> {
  const existing = await db
    .select({ id: teamConversations.id })
    .from(teamConversations)
    .where(
      and(
        eq(teamConversations.teamId, teamId),
        eq(teamConversations.title, title),
      ),
    )
    .orderBy(desc(teamConversations.createdAt))
    .limit(1);

  if (existing.length > 0) return existing[0].id;

  const [created] = await db
    .insert(teamConversations)
    .values({ teamId, title })
    .returning({ id: teamConversations.id });

  if (!created) {
    throw new Error(
      `resolveRollingConversation: insert returned nothing for team ${teamId}, title ${title}`,
    );
  }
  return created.id;
}
