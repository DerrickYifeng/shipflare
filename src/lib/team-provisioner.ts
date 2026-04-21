// Minimal team provisioner for Phase B.
//
// Creates the base-roster team for a (userId, productId) when none exists:
//   - one `teams` row
//   - one `team_members` row per core agent (coordinator,
//     growth-strategist, content-planner)
//
// Phase F layers category presets on top of this (dev_tool gets a reddit
// writer; consumer gets a community manager; etc.). Until Phase F ships
// the base roster is the full roster.
//
// Idempotent: re-running against an existing team returns the existing
// ids without mutating rows. The unique index on
// `team_members (team_id, agent_type)` guards against duplicate inserts
// at the DB layer too, so concurrent provisioner calls still land
// cleanly.

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { teams, teamMembers } from '@/lib/db/schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:team-provisioner');

export type BaseAgentType =
  | 'coordinator'
  | 'growth-strategist'
  | 'content-planner';

export interface BaseDisplayNames {
  coordinator: string;
  'growth-strategist': string;
  'content-planner': string;
}

// Default display names. Real product copy will replace these in Phase F's
// "Meet your team" intro; for Phase B we seed friendly first names so the
// UI has something to render.
const DEFAULT_DISPLAY_NAMES: BaseDisplayNames = {
  coordinator: 'Sam',
  'growth-strategist': 'Alex',
  'content-planner': 'Maya',
};

export interface EnsureTeamResult {
  teamId: string;
  memberIds: Record<BaseAgentType, string>;
  created: boolean;
}

/**
 * Ensure a team + base roster exists for (userId, productId). Returns the
 * teamId and a map of agent_type → member id. Production callers (the
 * /api/onboarding/plan route, /api/team/run, and the weekly scheduler)
 * use this instead of rolling their own provisioning.
 */
export async function ensureTeamExists(
  userId: string,
  productId: string | null,
  displayNameOverrides?: Partial<BaseDisplayNames>,
): Promise<EnsureTeamResult> {
  const displayNames: BaseDisplayNames = {
    ...DEFAULT_DISPLAY_NAMES,
    ...(displayNameOverrides ?? {}),
  };

  // Look up an existing team for this (userId, productId).
  const existing = productId
    ? await db
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.userId, userId), eq(teams.productId, productId)))
        .limit(1)
    : await db
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.userId, userId))
        .limit(1);

  let teamId: string;
  let created = false;

  if (existing.length > 0) {
    teamId = existing[0].id;
  } else {
    teamId = crypto.randomUUID();
    await db.insert(teams).values({
      id: teamId,
      userId,
      productId: productId ?? null,
      name: 'My Marketing Team',
      config: {},
    });
    created = true;
    log.info(
      `ensureTeamExists: created team ${teamId} user=${userId} product=${productId ?? 'null'}`,
    );
  }

  // Fetch existing members for this team — we skip insertion for any agent
  // type that's already present.
  const existingMembers = await db
    .select({ id: teamMembers.id, agentType: teamMembers.agentType })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));

  const byType = new Map<string, string>();
  for (const m of existingMembers) {
    byType.set(m.agentType, m.id);
  }

  const baseTypes: BaseAgentType[] = [
    'coordinator',
    'growth-strategist',
    'content-planner',
  ];

  const memberIds: Partial<Record<BaseAgentType, string>> = {};
  for (const agentType of baseTypes) {
    const existingId = byType.get(agentType);
    if (existingId) {
      memberIds[agentType] = existingId;
      continue;
    }
    const newId = crypto.randomUUID();
    await db.insert(teamMembers).values({
      id: newId,
      teamId,
      agentType,
      displayName: displayNames[agentType],
      status: 'idle',
    });
    memberIds[agentType] = newId;
    log.info(
      `ensureTeamExists: added ${agentType} (${displayNames[agentType]}) as member ${newId} to team ${teamId}`,
    );
  }

  return {
    teamId,
    memberIds: memberIds as Record<BaseAgentType, string>,
    created,
  };
}
