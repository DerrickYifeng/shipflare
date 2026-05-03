// Feature flag for the Agent Teams async lifecycle (Phase B).
//
// Phase B scope: env-var-only check. The function takes a `teamId`
// parameter for forward compatibility — Phase E will add per-team DB
// overrides so we can graduate teams individually before flipping the
// global flag.
//
// Truthy env values: '1', 'true' (case-insensitive). Anything else =
// false (including unset).

const TRUTHY = new Set(['1', 'true']);

/**
 * Check whether Agent Teams async lifecycle is enabled for the given team.
 *
 * Phase B: returns env-var truthiness; teamId unused.
 * Phase E: will check `teams.feature_agent_teams` column override first,
 * fall back to env.
 */
export async function isAgentTeamsEnabledForTeam(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _teamId: string,
): Promise<boolean> {
  const raw = process.env.SHIPFLARE_AGENT_TEAMS?.toLowerCase().trim();
  return raw !== undefined && TRUTHY.has(raw);
}
