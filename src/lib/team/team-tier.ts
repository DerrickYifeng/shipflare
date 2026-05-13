// Phase B3: per-tenant in-flight cap by billing tier.
//
// The agent-run worker queries this module ONCE per BullMQ job to look up
// the owning user's `userId` + `tier`, then asks the tenant semaphore for
// a slot (`acquireTenantSlot(redis, userId, cap, ttl)`). The cap is by
// USER, not by agent — a single user's lead + N teammates all share the
// same quota. This stops a runaway loop (e.g. lead spawning 50 async
// teammates) from monopolising the worker pool and starving other
// tenants.
//
// Phase B hardcodes every user to `'free'`. When billing lands, replace
// the constant in `tierForAgentRun` with a `users.tier` lookup; the
// cap-by-tier table here is the only knob ops needs to tune.

import { db } from '@/lib/db';
import { agentRuns, teamMembers, teams } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export type Tier = 'free' | 'paid' | 'premium';

/**
 * Per-tenant in-flight agent-run cap by billing tier.
 *
 * Caps are intentionally low — the worker pool is shared across all
 * tenants and a single user's runaway loop must not be able to starve
 * everyone else. Numbers are starting points; tune once we have real
 * data on tier-vs-fairness tradeoffs.
 */
const CAP_BY_TIER: Record<Tier, number> = {
  free: 3,
  paid: 10,
  premium: 25,
};

export function inflightCapForTier(tier: Tier): number {
  return CAP_BY_TIER[tier];
}

/**
 * Look up the owning user + tier for an `agent_runs` row.
 *
 * Joins `agent_runs → team_members → teams` to recover `teams.userId`.
 * All three are notNull FKs with an index on the joining column, so this
 * is a sub-ms three-row probe. Caching is intentionally avoided in B3 —
 * the budget should show up in profiling before we add a cache layer.
 *
 * Throws if the agent row doesn't exist. NOTE for the agent-run caller:
 * this throw happens BEFORE the semaphore acquire, so there's nothing to
 * release on the failure path. If a future refactor moves the lookup
 * inside the acquire+try block, the catch path must release the slot.
 *
 * Until billing lands, every user is `'free'` — when `users.tier` exists,
 * extend the query to project it and return the live value.
 */
export async function tierForAgentRun(agentId: string): Promise<{
  userId: string;
  tier: Tier;
}> {
  const rows = await db
    .select({ userId: teams.userId })
    .from(agentRuns)
    .innerJoin(teamMembers, eq(agentRuns.memberId, teamMembers.id))
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(agentRuns.id, agentId))
    .limit(1);
  const userId = rows[0]?.userId;
  if (!userId) {
    throw new Error(`tierForAgentRun: agent ${agentId} has no userId`);
  }
  // Until billing: hardcode `free`. Replace with `users.tier` lookup later.
  return { userId, tier: 'free' };
}
