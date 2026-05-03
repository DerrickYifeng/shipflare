// System-prompt placeholder substitution.
//
// The coordinator's AGENT.md (and any future lead/teammate prompt) ships
// with handlebars-style tokens that are filled at run time so the agent
// sees a rendered prompt — not literal `{productName}` etc. — when the
// worker hands it to runAgent.
//
// Two exports:
//   - `loadSystemPromptContext({ teamId, db })` queries product /
//     strategic_path / plan_items / channels / user / team_members and
//     resolves each `agent_type` through the registry to build a roster
//     line per teammate.
//   - `substitutePlaceholders(template, ctx)` is a small synchronous
//     replace chain. It NEVER throws on a missing token — unmatched
//     braces flow through verbatim (the AGENT.md author owns the
//     template, not this helper).
//
// Wire-in: the agent-run worker calls `loadSystemPromptContext` once
// per spawn before `buildAgentConfigFromDefinition`, then renders
// `def.systemPrompt` through `substitutePlaceholders`. No engine
// touches; no schema migration.

import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import {
  teams,
  teamMembers,
  planItems,
  channels as channelsTable,
  strategicPaths,
} from '@/lib/db/schema';
import { products } from '@/lib/db/schema/products';
import { users } from '@/lib/db/schema/users';
import { resolveAgent } from '@/tools/AgentTool/registry';
import { formatAgentLine } from '@/tools/AgentTool/prompt';
import type { AgentDefinition } from '@/tools/AgentTool/loader';
import type { db as Db } from '@/lib/db';
import { createLogger } from '@/lib/logger';

const log = createLogger('system-prompt-context');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SystemPromptContext {
  productName: string;
  productDescription: string;
  productState: string;
  currentPhase: string;
  channels: string;
  strategicPathId: string;
  itemCount: number;
  statusBreakdown: string;
  founderName: string;
  teamRoster: string;
}

// ---------------------------------------------------------------------------
// substitutePlaceholders
// ---------------------------------------------------------------------------

/**
 * Replace every documented token in `template` with the matching
 * `ctx` field. Unknown tokens flow through verbatim — never throws.
 *
 * Order matters: `{pathId | "none yet"}` must match BEFORE `{pathId}`
 * so the trailing `| "none yet"` literal isn't orphaned. The two
 * forms are otherwise interchangeable.
 */
export function substitutePlaceholders(
  template: string,
  ctx: SystemPromptContext,
): string {
  // Use simple string replace with global flags. Tokens are literal,
  // not regex-patterned, so plain `.split(...).join(...)` (or .replaceAll
  // on supported runtimes) is enough — and avoids any escaping subtlety
  // around the inner `"none yet"`.
  let out = template;
  // Long form first.
  out = out.split('{pathId | "none yet"}').join(ctx.strategicPathId);
  out = out.split('{pathId}').join(ctx.strategicPathId);
  out = out.split('{productName}').join(ctx.productName);
  out = out.split('{productDescription}').join(ctx.productDescription);
  out = out.split('{productState}').join(ctx.productState);
  out = out.split('{currentPhase}').join(ctx.currentPhase);
  out = out.split('{channels}').join(ctx.channels);
  out = out.split('{itemCount}').join(String(ctx.itemCount));
  out = out.split('{statusBreakdown}').join(ctx.statusBreakdown);
  out = out.split('{TEAM_ROSTER}').join(ctx.teamRoster);
  out = out.split('{founderName}').join(ctx.founderName);
  return out;
}

// ---------------------------------------------------------------------------
// formatTeamRoster
// ---------------------------------------------------------------------------

/**
 * Format a one-line-per-agent roster from loaded `AgentDefinition`s. Reuses
 * `formatAgentLine` from `@/tools/AgentTool/prompt` so the line shape stays
 * in lockstep with the Task tool's delegation roster.
 */
export function formatTeamRoster(defs: AgentDefinition[]): string {
  if (defs.length === 0) return '';
  return defs.map(formatAgentLine).join('\n');
}

// ---------------------------------------------------------------------------
// UTC week boundaries
// ---------------------------------------------------------------------------

/**
 * Monday 00:00:00 UTC of the current week → next Monday 00:00:00 UTC.
 * Plain `Date` arithmetic; no date library.
 *
 * `Date.prototype.getUTCDay()` returns 0 for Sunday, 1 for Monday, ...
 * To anchor on Monday we shift Sunday (0) to 7 so subtracting `(day - 1)`
 * always lands on the most recent Monday.
 */
function currentUtcWeekRange(now: Date = new Date()): { start: Date; end: Date } {
  const dayOfWeek = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  start.setUTCDate(start.getUTCDate() - (dayOfWeek - 1));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}

// ---------------------------------------------------------------------------
// loadSystemPromptContext
// ---------------------------------------------------------------------------

interface LoadArgs {
  teamId: string;
  db: typeof Db;
}

/**
 * Query product / strategic_path / plan_items / channels / user /
 * team_members and assemble the substitution context for one team.
 *
 * Throws `Error('team not found: <id>')` when the team row is missing
 * — that's the only fatal error. All other lookups have safe defaults
 * so a freshly-onboarded team (no product, no path, no items) still
 * gets a coherent rendered prompt.
 *
 * Task 2 (2026-05-03 plan): the loader returns both the rendered ctx
 * AND the team row it queried internally. agent-run.ts is the only
 * caller and used to run a duplicate `select({id, userId, productId})
 * .from(teams)` 13 lines after this; exposing the row here lets it
 * drop that second query without losing the typed shape it consumed.
 *
 * Task 2 also parallelizes the dependent queries — six of the seven
 * SELECTs (product, strategic_path, channels, plan_items, user,
 * team_members) only need `team.userId` / `team.productId`, so they
 * fire concurrently via `Promise.all` once the team row settles.
 * The roster's per-member `resolveAgent(...)` lookups are likewise
 * parallelized so a 12-member team doesn't pay 12× sequential
 * registry latency. Behavior is otherwise identical to the prior
 * sequential implementation: same defaults, same throw-on-missing-team,
 * same skip-with-warn for unresolvable agentTypes.
 */
export async function loadSystemPromptContext(
  args: LoadArgs,
): Promise<{
  ctx: SystemPromptContext;
  team: { id: string; userId: string; productId: string | null };
}> {
  const { teamId, db } = args;

  // 1. team — must resolve before the parallel batch so its userId /
  //    productId can fan out into the dependent queries.
  const teamRows = (await db
    .select({ id: teams.id, userId: teams.userId, productId: teams.productId })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1)) as Array<{
    id: string;
    userId: string;
    productId: string | null;
  }>;
  if (teamRows.length === 0) {
    throw new Error(`team not found: ${teamId}`);
  }
  const team = teamRows[0];

  // 2-7. dependent queries — fire concurrently. Each returns its own
  //      shape and gets normalized below. The `productId === null`
  //      branch returns an empty array via Promise.resolve so the
  //      positional unpacking stays uniform.
  const week = currentUtcWeekRange();
  const [productRows, pathRows, channelRows, planItemRows, userRows, memberRows] =
    await Promise.all([
      // 2. product (only when productId is set)
      team.productId !== null
        ? (db
            .select({
              id: products.id,
              name: products.name,
              description: products.description,
              state: products.state,
            })
            .from(products)
            .where(eq(products.id, team.productId))
            .limit(1) as Promise<
            Array<{
              id: string;
              name: string;
              description: string;
              state: string;
            }>
          >)
        : Promise.resolve(
            [] as Array<{
              id: string;
              name: string;
              description: string;
              state: string;
            }>,
          ),
      // 3. active strategic_path — keyed by userId, most recent first
      db
        .select({ id: strategicPaths.id, phase: strategicPaths.phase })
        .from(strategicPaths)
        .where(eq(strategicPaths.userId, team.userId))
        .orderBy(desc(strategicPaths.generatedAt))
        .limit(1) as Promise<Array<{ id: string; phase: string }>>,
      // 4. channels — explicit projection (CLAUDE.md security note;
      //    never select token columns from channels)
      db
        .select({ platform: channelsTable.platform })
        .from(channelsTable)
        .where(eq(channelsTable.userId, team.userId)) as Promise<
        Array<{ platform: string }>
      >,
      // 5. plan items this UTC week — group by state for breakdown
      db
        .select({
          state: planItems.state,
          count: sql<number>`count(*)`,
        })
        .from(planItems)
        .where(
          and(
            eq(planItems.userId, team.userId),
            gte(planItems.scheduledAt, week.start),
            lt(planItems.scheduledAt, week.end),
          ),
        )
        .groupBy(planItems.state) as Promise<
        Array<{ state: string; count: number | string }>
      >,
      // 6. founder name source
      db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, team.userId))
        .limit(1) as Promise<
        Array<{ id: string; name: string | null; email: string | null }>
      >,
      // 7. team roster source — resolveAgent calls fan out below
      db
        .select({
          id: teamMembers.id,
          teamId: teamMembers.teamId,
          agentType: teamMembers.agentType,
        })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, teamId)) as Promise<
        Array<{ id: string; teamId: string; agentType: string }>
      >,
    ]);

  // 2. product fields (defaults flow through when productId is null
  //    or the row is missing).
  let productName = 'your product';
  let productDescription = '(product not configured)';
  let productState = 'unknown';
  if (productRows.length > 0) {
    productName = productRows[0].name;
    productDescription = productRows[0].description;
    productState = productRows[0].state;
  }

  // 3. strategic_path — defaults stay when no row.
  let currentPhase = 'unknown';
  let strategicPathId = 'none yet';
  if (pathRows.length > 0) {
    strategicPathId = pathRows[0].id;
    currentPhase = pathRows[0].phase;
  }

  // 4. channels — dedupe in JS for portability across Drizzle dialect
  //    quirks; identical output to a `selectDistinct`.
  const uniquePlatforms = Array.from(
    new Set(channelRows.map((r) => r.platform)),
  );
  const channelsStr =
    uniquePlatforms.length > 0 ? uniquePlatforms.join(', ') : 'none yet';

  // 5. plan items breakdown — coerce bigint→number defensively (some
  //    Postgres drivers return count as a string).
  const normalized = planItemRows.map((r) => ({
    state: r.state,
    count: typeof r.count === 'string' ? Number(r.count) : r.count,
  }));
  const itemCount = normalized.reduce((acc, r) => acc + r.count, 0);
  const statusBreakdown =
    itemCount === 0
      ? ''
      : normalized
          .filter((r) => r.count > 0)
          .sort((a, b) => b.count - a.count)
          .map((r) => `${r.state}: ${r.count}`)
          .join(', ');

  // 6. founder name — prefer name, then email's local-part, then default.
  let founderName = 'founder';
  if (userRows.length > 0) {
    const u = userRows[0];
    if (u.name !== null && u.name.length > 0) {
      founderName = u.name;
    } else if (u.email !== null && u.email.length > 0) {
      const local = u.email.split('@')[0];
      if (local.length > 0) founderName = local;
    }
  }

  // 7. team roster — resolveAgent in parallel; skip-with-warn for
  //    unresolvable agentTypes (legacy member referring to an agent
  //    the registry no longer knows about) so the rest of the team
  //    still renders. Each resolveAgent is wrapped in its own
  //    try/catch so one failure can't reject the whole Promise.all.
  const resolved = await Promise.all(
    memberRows.map(async (m) => {
      try {
        const def = await resolveAgent(m.agentType);
        if (def === null) {
          log.warn(
            `loadSystemPromptContext team=${teamId}: registry could not resolve agentType=${m.agentType}; skipping from roster`,
          );
          return null;
        }
        return def;
      } catch (err) {
        log.warn(
          `loadSystemPromptContext team=${teamId}: resolveAgent threw for agentType=${m.agentType}; skipping. ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }),
  );
  const defs: AgentDefinition[] = resolved.filter(
    (d): d is AgentDefinition => d !== null,
  );
  const teamRoster = formatTeamRoster(defs);

  return {
    ctx: {
      productName,
      productDescription,
      productState,
      currentPhase,
      channels: channelsStr,
      strategicPathId,
      itemCount,
      statusBreakdown,
      founderName,
      teamRoster,
    },
    team: {
      id: team.id,
      userId: team.userId,
      productId: team.productId,
    },
  };
}
