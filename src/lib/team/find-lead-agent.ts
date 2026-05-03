// Phase E: read-only lookup for the lead's agent_runs.id for a given team.
//
// Used by SendMessage to resolve "the lead" for peer-DM-shadow + wake routing.
// Replaces the placeholder `getLeadAgentId` helpers from Phase C that returned
// null. Companion to `ensureLeadAgentRun` in `./spawn-lead.ts`.

import { and, eq } from 'drizzle-orm';
import { agentRuns } from '@/lib/db/schema';
import type { Database } from '@/lib/db';

const LEAD_AGENT_DEF_NAME = 'coordinator'; // Phase F may rename to 'team-lead'

export async function findLeadAgentId(
  teamId: string,
  db: Database,
): Promise<string | null> {
  const rows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.teamId, teamId),
        eq(agentRuns.agentDefName, LEAD_AGENT_DEF_NAME),
      ),
    )
    .limit(1);
  return rows.length > 0 ? rows[0].id : null;
}
