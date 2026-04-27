// Team preset logic — pure functions + types.
//
// Extracted from `team-provisioner.ts` to break the server-only DB imports
// (postgres, drizzle, @/lib/db) off the client boundary. Client components
// on the onboarding flow import the preset preview (pickPresetByCategory,
// getTeamCompositionForPreset, DEFAULT_DISPLAY_NAMES, types) directly from
// this file.
//
// `team-provisioner.ts` re-exports everything here so server callers don't
// have to change their import paths.

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

/**
 * Baseline agent roster present in every team. `memberIds` exposes one id
 * per BaseAgentType so `plan-execute` / `team-run` callers can route
 * without reading the config.
 *
 * Phase 6 (agent-cleanup) dropped `reply-drafter` from the baseline —
 * community-manager now owns reply drafting end-to-end (drafts the body
 * inline + self-checks against the slop / anchor / length / stats rules
 * in its references), so the standalone reply-drafter teammate is gone.
 */
export type BaseAgentType =
  | 'coordinator'
  | 'growth-strategist'
  | 'content-planner';

/**
 * Writer + community agents layered on top of the baseline by preset.
 * `post-writer` is a single channel-aware writer — `plan_items.channel`
 * (`x` or `reddit`) decides the platform tone via the writer's reference
 * docs at draft time, so we no longer split the roster by platform.
 * `community-manager` owns the entire reply pipeline post-Phase-6.
 */
export type WriterAgentType =
  | 'post-writer'
  | 'community-manager';

/**
 * Full agent type set. Must match AGENT.md `name` under
 * `src/tools/AgentTool/agents/<agent_type>`.
 */
export type AgentType = BaseAgentType | WriterAgentType;

// ---------------------------------------------------------------------------
// Presets + category mapping
// ---------------------------------------------------------------------------

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
  'post-writer': string;
  'community-manager': string;
}

/**
 * Default display names used by the provisioner and the "Meet your team"
 * onboarding card. Role labels (not personal names) so copy reads honestly —
 * "Post Writer" instead of "Jordan".
 */
export const DEFAULT_DISPLAY_NAMES: DisplayNameMap = {
  coordinator: 'Chief of Staff',
  'growth-strategist': 'Head of Growth',
  'content-planner': 'Head of Content',
  'post-writer': 'Post Writer',
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
  const base: AgentType[] = [
    'coordinator',
    'growth-strategist',
    'content-planner',
  ];
  switch (preset) {
    case 'dev-squad':
      return [...base, 'post-writer', 'community-manager'];
    case 'saas-squad':
      return [...base, 'post-writer', 'community-manager'];
    case 'consumer-squad':
      return [...base, 'post-writer', 'community-manager'];
    case 'default-squad':
      return [...base, 'post-writer'];
  }
}
