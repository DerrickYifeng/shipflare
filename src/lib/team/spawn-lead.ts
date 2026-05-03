// Phase E: ensure each team has exactly one lead agent_runs row.
//
// Before Phase E, the lead was driven implicitly by team-run.ts and never
// had its own agent_runs row. Phase E unifies: lead is just an agent_runs
// row with agentDefName='coordinator' (the team_members.agentType used to
// identify the lead — Phase F may rename this to 'team-lead').
//
// `ensureLeadAgentRun` is idempotent: returns the existing lead's agentId,
// or creates a new sleeping row if absent. Called from the founder UI
// API route + (future) at team creation time.

import { and, eq } from 'drizzle-orm';
import { agentRuns, teamMembers } from '@/lib/db/schema';
import type { Database } from '@/lib/db';

const LEAD_AGENT_DEF_NAME = 'coordinator'; // Phase F may rename to 'team-lead'

export interface EnsureLeadResult {
  agentId: string;
}

export async function ensureLeadAgentRun(
  teamId: string,
  db: Database,
): Promise<EnsureLeadResult> {
  // Look for existing lead row first (idempotent fast path).
  const existing = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.teamId, teamId),
        eq(agentRuns.agentDefName, LEAD_AGENT_DEF_NAME),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return { agentId: existing[0].id };
  }

  // Find lead's team_members row. Lead is identified by matching
  // team_members.agentType against the AGENT.md folder name ('coordinator').
  const leadMember = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.agentType, LEAD_AGENT_DEF_NAME),
      ),
    )
    .limit(1);

  if (leadMember.length === 0) {
    throw new Error(
      `Cannot ensure lead agent_run: team ${teamId} has no member with agentType=${LEAD_AGENT_DEF_NAME}`,
    );
  }

  // Create a new sleeping lead row. parentAgentId=null because the lead
  // has no parent (the founder UI is the implicit caller, not another agent).
  const newId = crypto.randomUUID();
  await db.insert(agentRuns).values({
    id: newId,
    teamId,
    memberId: leadMember[0].id,
    agentDefName: LEAD_AGENT_DEF_NAME,
    parentAgentId: null,
    status: 'sleeping',
  });

  return { agentId: newId };
}
