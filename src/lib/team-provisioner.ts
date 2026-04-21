// Team provisioner.
//
// Phase B shipped the minimal 3-role roster (coordinator + growth-strategist +
// content-planner). Phase F layers category presets on top — dev_tool picks
// up an x-writer + community-manager, consumer picks up a reddit-writer +
// community-manager, etc. The 3-role baseline stays as the floor so legacy
// callers of `ensureTeamExists` keep working and older teams keep rendering.
//
// Idempotent: re-running against an existing team returns the existing ids
// without mutating rows. The unique index on `team_members (team_id,
// agent_type)` guards against duplicate inserts at the DB layer too, so
// concurrent provisioner calls still land cleanly. Re-running after a new
// channel connects RECONCILES — it inserts any missing members but never
// removes existing ones.

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { teams, teamMembers, products, channels } from '@/lib/db/schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:team-provisioner');

// ---------------------------------------------------------------------------
// Agent types + presets
// ---------------------------------------------------------------------------

/**
 * Baseline agent roster present in every team. `memberIds` always exposes
 * exactly these three ids so `plan-execute` / `team-run` callers can route
 * without reading the config.
 */
export type BaseAgentType =
  | 'coordinator'
  | 'growth-strategist'
  | 'content-planner';

/**
 * Writer + community agents layered on top of the baseline by preset.
 */
export type WriterAgentType =
  | 'x-writer'
  | 'reddit-writer'
  | 'community-manager';

/**
 * Full agent type set. Must match AGENT.md `name` under
 * `src/tools/AgentTool/agents/<agent_type>`.
 */
export type AgentType = BaseAgentType | WriterAgentType;

/**
 * Team preset — a named roster shape selected from the product's category.
 * `default-squad` is the safe fallback when category is unknown.
 */
export type TeamPreset =
  | 'dev-squad'
  | 'saas-squad'
  | 'consumer-squad'
  | 'default-squad';

/**
 * Product category as stored in `products.category`. Mirrors the onboarding
 * component's ProductCategory union. Kept as a string literal type instead
 * of an enum so server code doesn't pay for a runtime enum import.
 */
export type ProductCategory =
  | 'dev_tool'
  | 'saas'
  | 'ai_app'
  | 'consumer'
  | 'creator_tool'
  | 'agency'
  | 'other';

export interface DisplayNameMap {
  coordinator: string;
  'growth-strategist': string;
  'content-planner': string;
  'x-writer': string;
  'reddit-writer': string;
  'community-manager': string;
}

/**
 * Default display names used by the provisioner and the "Meet your team"
 * onboarding card. Role labels (not personal names) so copy reads honestly —
 * "X Writer" instead of "Jordan".
 */
export const DEFAULT_DISPLAY_NAMES: DisplayNameMap = {
  coordinator: 'Chief of Staff',
  'growth-strategist': 'Head of Growth',
  'content-planner': 'Head of Content',
  'x-writer': 'X Writer',
  'reddit-writer': 'Reddit Writer',
  'community-manager': 'Community Manager',
};

/**
 * Map a product category to the right preset. Unknown or null category
 * falls back to `default-squad`.
 */
export function pickPresetByCategory(
  category: ProductCategory | null | undefined,
): TeamPreset {
  switch (category) {
    case 'dev_tool':
      return 'dev-squad';
    case 'saas':
    case 'ai_app':
      return 'saas-squad';
    case 'consumer':
      return 'consumer-squad';
    case 'creator_tool':
    case 'agency':
    case 'other':
    default:
      return 'default-squad';
  }
}

/**
 * The roster for a preset. Order matters for deterministic insertion +
 * the Meet-your-team card. The 3-role baseline always comes first.
 */
export function getTeamCompositionForPreset(preset: TeamPreset): AgentType[] {
  const base: AgentType[] = ['coordinator', 'growth-strategist', 'content-planner'];
  switch (preset) {
    case 'dev-squad':
      return [...base, 'x-writer', 'community-manager'];
    case 'saas-squad':
      return [...base, 'x-writer', 'community-manager'];
    case 'consumer-squad':
      return [...base, 'reddit-writer', 'community-manager'];
    case 'default-squad':
      return [...base, 'x-writer'];
  }
}

// ---------------------------------------------------------------------------
// ensureTeamExists — preserved baseline API (3 roles) used by plan-execute +
// team-run callers. Now optionally takes a preset; when absent it defaults
// to the baseline roster (backwards compatible).
// ---------------------------------------------------------------------------

export interface EnsureTeamResult {
  teamId: string;
  memberIds: Record<BaseAgentType, string>;
  created: boolean;
}

export interface EnsureTeamOptions {
  /**
   * Optional display-name overrides; when present they replace the default
   * "Chief of Staff"/"Head of Growth"/etc. labels for the matching agent
   * types during the INSERT. Existing rows are never re-named.
   */
  displayNames?: Partial<DisplayNameMap>;
  /**
   * Optional preset. When provided, the full preset roster is ensured
   * (baseline + writers + community roles). When absent the function
   * seeds only the 3-role baseline for backwards compatibility with
   * pre-Phase-F callers.
   */
  preset?: TeamPreset;
}

/**
 * Ensure a team + roster exists for (userId, productId). Returns the
 * teamId and a map of the 3 baseline agent_types → member id. Callers
 * that need writer/community member ids should re-query `team_members`.
 */
export async function ensureTeamExists(
  userId: string,
  productId: string | null,
  options?: EnsureTeamOptions,
): Promise<EnsureTeamResult> {
  const displayNames: DisplayNameMap = {
    ...DEFAULT_DISPLAY_NAMES,
    ...(options?.displayNames ?? {}),
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
      config: options?.preset ? { preset: options.preset } : {},
    });
    created = true;
    log.info(
      `ensureTeamExists: created team ${teamId} user=${userId} product=${productId ?? 'null'} preset=${options?.preset ?? 'baseline'}`,
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

  const roster: AgentType[] = options?.preset
    ? getTeamCompositionForPreset(options.preset)
    : ['coordinator', 'growth-strategist', 'content-planner'];

  for (const agentType of roster) {
    if (byType.has(agentType)) continue;
    const newId = crypto.randomUUID();
    await db.insert(teamMembers).values({
      id: newId,
      teamId,
      agentType,
      displayName: displayNames[agentType],
      status: 'idle',
    });
    byType.set(agentType, newId);
    log.info(
      `ensureTeamExists: added ${agentType} (${displayNames[agentType]}) as member ${newId} to team ${teamId}`,
    );
  }

  // Baseline 3 must always be present after this call — the insert loop
  // above guarantees it by including them in `roster`.
  const memberIds: Record<BaseAgentType, string> = {
    coordinator: byType.get('coordinator')!,
    'growth-strategist': byType.get('growth-strategist')!,
    'content-planner': byType.get('content-planner')!,
  };

  return { teamId, memberIds, created };
}

// ---------------------------------------------------------------------------
// provisionTeamForProduct — product-aware entry point (reads category +
// connected channels to pick the right preset, then delegates to
// ensureTeamExists).
// ---------------------------------------------------------------------------

export interface ProvisionResult {
  teamId: string;
  preset: TeamPreset;
  roster: AgentType[];
  created: boolean;
  membersInserted: number;
}

/**
 * Provision (or reconcile) a team for a product. Reads the product's
 * `category` + the user's connected `channels` to decide the preset, then
 * ensures every member in that roster exists.
 *
 * Safe to call repeatedly:
 *   - First call creates the team + all members.
 *   - Subsequent calls after a new channel connects insert only the
 *     delta (e.g. adding `reddit-writer` when reddit becomes available).
 *   - Existing members are never renamed, re-statused, or removed.
 *
 * When `productId` is null or the product doesn't exist, falls back to
 * `default-squad` and provisions against the user's bare team (no product
 * link) — so pre-onboarding callers can still seed a skeleton team.
 */
export async function provisionTeamForProduct(
  userId: string,
  productId: string | null,
): Promise<ProvisionResult> {
  // Read category from products (may be null/undefined for freshly-created
  // products that haven't picked a category yet).
  let category: ProductCategory | null = null;
  if (productId) {
    const [row] = await db
      .select({ category: products.category })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);
    category = (row?.category ?? null) as ProductCategory | null;
  }

  const basePreset = pickPresetByCategory(category);

  // Channel-aware adjustment: if the user has only X connected, skip
  // reddit-writer even for a consumer preset (and vice versa). Minimal rule:
  // when the preset asks for reddit-writer but the user has no reddit
  // channel connected, fall back to default-squad so we don't seed a dead
  // member. The `ensureTeamExists` reconcile path will add reddit-writer
  // later when reddit connects.
  const userChannels = await db
    .select({ platform: channels.platform })
    .from(channels)
    .where(eq(channels.userId, userId));
  const hasReddit = userChannels.some((c) => c.platform === 'reddit');
  const hasX = userChannels.some((c) => c.platform === 'x');

  let preset = basePreset;
  if (basePreset === 'consumer-squad' && !hasReddit) {
    // Keep community-manager but swap the writer: if they have X, use
    // dev-squad's composition; otherwise default-squad (no writer yet).
    preset = hasX ? 'saas-squad' : 'default-squad';
  }
  if (
    (basePreset === 'dev-squad' || basePreset === 'saas-squad') &&
    !hasX &&
    !hasReddit
  ) {
    preset = 'default-squad';
  }

  const roster = getTeamCompositionForPreset(preset);

  const result = await ensureTeamExists(userId, productId, { preset });

  // Count how many roster roles are now backed by team_members rows.
  const after = await db
    .select({ agentType: teamMembers.agentType })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, result.teamId));
  const presentTypes = new Set(after.map((r) => r.agentType));
  const membersInserted = roster.filter((r) => presentTypes.has(r)).length;

  log.info(
    `provisionTeamForProduct: user=${userId} product=${productId ?? 'null'} category=${category ?? 'null'} preset=${preset} roster=[${roster.join(',')}] created=${result.created} membersInserted=${membersInserted}`,
  );

  return {
    teamId: result.teamId,
    preset,
    roster,
    created: result.created,
    membersInserted,
  };
}
