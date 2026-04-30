/**
 * Small helpers for automation / cron code paths that need to spawn a
 * team_run but don't have a user-facing conversation to attach it to.
 *
 * The chat refactor made `conversationId` required on every run. Cron
 * triggers (weekly replan, onboarding, daily run, phase transition)
 * still need to spawn runs — so we mint a fresh conversation per
 * trigger invocation, titled with the trigger name so ops can recognize
 * it in the sidebar. These conversations are first-class; the user can
 * open them to inspect what the system did on their behalf.
 */

import { db as defaultDb, type Database } from '@/lib/db';
import { teamConversations } from '@/lib/db/schema';

export type AutomationTrigger =
  | 'onboarding'
  | 'kickoff'
  | 'weekly'
  | 'daily'
  | 'phase_transition'
  | 'draft_post';

const TITLE_PREFIX: Record<AutomationTrigger, string> = {
  onboarding: 'Onboarding',
  kickoff: 'Kickoff',
  weekly: 'Weekly plan',
  daily: 'Daily run',
  phase_transition: 'Phase transition',
  draft_post: 'Draft post',
};

/**
 * Create a new conversation for a cron / automation run and return
 * its id. Always mints a fresh row — callers invoking this helper are
 * starting a new work bundle, not continuing a chat thread.
 *
 * Title follows `"<trigger label> — <YYYY-MM-DD HH:mm>"` so the
 * sidebar distinguishes a Monday replan from last Monday's at a
 * glance.
 */
export async function createAutomationConversation(
  teamId: string,
  trigger: AutomationTrigger,
  db: Database = defaultDb,
): Promise<string> {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  const title = `${TITLE_PREFIX[trigger]} — ${stamp}`;

  const [created] = await db
    .insert(teamConversations)
    .values({ teamId, title })
    .returning({ id: teamConversations.id });

  if (!created) {
    throw new Error(
      `createAutomationConversation: insert returned nothing for team ${teamId}, trigger ${trigger}`,
    );
  }
  return created.id;
}
