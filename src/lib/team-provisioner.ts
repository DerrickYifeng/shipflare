// Team provisioner.
//
// Baseline roster: coordinator + content-planner.
// Phase F layers category presets on top — dev_tool / saas / consumer pick
// up a post-writer + content-manager, default-squad picks up just the
// post-writer. The baseline stays as the floor so legacy callers of
// `ensureTeamExists` keep working and older teams keep rendering.
// (`post-writer` is one channel-aware writer; the platform comes in via
// `plan_items.channel`, so we no longer split the roster by platform.
// `content-manager` owns reply drafting end-to-end since Phase 6 of
// the agent-cleanup migration — there is no separate reply-drafter
// teammate. It was renamed from `community-manager` in Phase J when
// it gained the post_batch original-post drafting flow alongside the
// existing reply_sweep flow.)
//
// Idempotent: re-running against an existing team returns the existing ids
// without mutating rows. The unique index on `team_members (team_id,
// agent_type)` guards against duplicate inserts at the DB layer too, so
// concurrent provisioner calls still land cleanly. Re-running after a new
// channel connects RECONCILES — it inserts any missing members but never
// removes existing ones.

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import { teams, teamMembers, products, channels } from '@/lib/db/schema';
import { createLogger } from '@/lib/logger';
import {
  DEFAULT_DISPLAY_NAMES,
  getTeamCompositionForPreset,
  pickPresetByCategory,
  type AgentType,
  type BaseAgentType,
  type DisplayNameMap,
  type ProductCategory,
  type TeamPreset,
  type WriterAgentType,
} from '@/lib/team-presets';

// Re-export the pure preset API so existing server callers (API routes,
// workers, tests) keep importing from `@/lib/team-provisioner`. The types +
// pure functions live in `@/lib/team-presets` — safe for client bundles,
// which must not pull the DB imports above.
export {
  DEFAULT_DISPLAY_NAMES,
  getTeamCompositionForPreset,
  pickPresetByCategory,
};
export type {
  AgentType,
  BaseAgentType,
  DisplayNameMap,
  ProductCategory,
  TeamPreset,
  WriterAgentType,
};

const log = createLogger('lib:team-provisioner');

// ---------------------------------------------------------------------------
// ensureTeamExists — preserved baseline API used by plan-execute + team-run
// callers. Now optionally takes a preset; when absent it defaults to the
// baseline roster (backwards compatible).
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
   * seeds only the baseline for backwards compatibility with pre-Phase-F
   * callers.
   */
  preset?: TeamPreset;
}

/**
 * Ensure a team + roster exists for (userId, productId). Returns the
 * teamId and a map of the baseline agent_types → member id. Callers
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
    : [
        'coordinator',
        'content-planner',
      ];

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

  // Baseline must always be present after this call — the insert loop
  // above guarantees it by including them in `roster`.
  const memberIds: Record<BaseAgentType, string> = {
    coordinator: byType.get('coordinator')!,
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
 *     delta (e.g. adding `content-manager` when a category is upgraded).
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
  // Phase G cleanup: if an orphan team with product_id=null exists for
  // this user (seeded by /api/onboarding/plan BEFORE the product row
  // existed), relink it to the new productId instead of inserting a
  // second team. Idempotent: if the relink target already has a
  // product_id team, we leave the null-product team alone and the
  // caller gets the product-scoped team below.
  if (productId) {
    const orphanRows = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.userId, userId), isNull(teams.productId)))
      .limit(2);
    if (orphanRows.length === 1) {
      // Single null-product team — safe to relink unless a product-scoped
      // team for this product already exists.
      const already = await db
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.userId, userId), eq(teams.productId, productId)))
        .limit(1);
      if (already.length === 0) {
        await db
          .update(teams)
          .set({ productId, updatedAt: new Date() })
          .where(eq(teams.id, orphanRows[0].id));
        log.info(
          `provisionTeamForProduct: relinked orphan team ${orphanRows[0].id} user=${userId} product=${productId}`,
        );
      }
    }
  }

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

  // Channel-aware adjustment: if no platform channel is connected at all,
  // fall back to default-squad — the content-manager has no inbox to
  // monitor. The post-writer is channel-agnostic at the agent layer
  // (`plan_items.channel` decides which guide it consults at draft time),
  // so we no longer split writers by platform — any of x / reddit being
  // connected is enough to seed the full preset.
  const userChannels = await db
    .select({ platform: channels.platform })
    .from(channels)
    .where(eq(channels.userId, userId));
  const hasReddit = userChannels.some((c) => c.platform === 'reddit');
  const hasX = userChannels.some((c) => c.platform === 'x');
  const hasAnyPlatformChannel = hasReddit || hasX;

  let preset = basePreset;
  if (
    (basePreset === 'dev-squad' ||
      basePreset === 'saas-squad' ||
      basePreset === 'consumer-squad') &&
    !hasAnyPlatformChannel
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
