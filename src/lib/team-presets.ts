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
 * Plan 3 (2026-05-04 collapse): the marketing-side specialists
 * (`content-manager`, `content-planner`, `discovery-agent`) were merged
 * into a single `social-media-manager` — the real industry job title for
 * someone who owns X (and later Reddit / LinkedIn / HN / Discord)
 * end-to-end. The strategic-path / plan-item generation that used to
 * live in `content-planner` was absorbed by the coordinator (chief of
 * staff scope at solo-founder scale).
 */
export type BaseAgentType = 'coordinator';

/**
 * Specialist agents layered on top of the baseline by preset.
 * `social-media-manager` owns the full social pipeline: discovery,
 * judging, reply drafting, and original-post drafting + scheduling
 * across every connected channel. Replaces the legacy
 * `content-manager` + `discovery-agent` pair retired in Plan 3.
 */
export type SocialAgentType = 'social-media-manager';

/**
 * Full agent type set. Must match AGENT.md `name` under
 * `src/tools/AgentTool/agents/<agent_type>`.
 */
export type AgentType = BaseAgentType | SocialAgentType;

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
  'social-media-manager': string;
}

/**
 * Default display names used by the provisioner and the "Meet your team"
 * onboarding card. Role labels (not personal names) so copy reads honestly —
 * "Social Media Manager" instead of "Jordan".
 */
export const DEFAULT_DISPLAY_NAMES: DisplayNameMap = {
  coordinator: 'Chief of Staff',
  'social-media-manager': 'Social Media Manager',
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
 * the Meet-your-team card. The baseline always comes first.
 *
 * Plan 3 (2026-05-04): every category-specific preset layers a single
 * `social-media-manager` onto the coordinator baseline. `default-squad`
 * stays at the baseline alone (no platform connected, nothing for the
 * social specialist to work).
 */
export function getTeamCompositionForPreset(preset: TeamPreset): AgentType[] {
  const base: AgentType[] = ['coordinator'];
  switch (preset) {
    case 'dev-squad':
      return [...base, 'social-media-manager'];
    case 'saas-squad':
      return [...base, 'social-media-manager'];
    case 'consumer-squad':
      return [...base, 'social-media-manager'];
    case 'default-squad':
      return [...base];
  }
}
