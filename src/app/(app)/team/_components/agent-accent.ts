import type { BadgeVariant } from '@/components/ui/badge';

/**
 * Per-agent-type accents. Shared between MemberCard (grid), TeamMemberPage
 * (hero avatar), and the member status Badge so a given specialist reads
 * the same color everywhere.
 *
 * We map to the existing `--sf-*` palette rather than inventing new hues:
 * - `accent` = blue   → coordinator (chief-of-staff feel, Apple Blue)
 * - `success` = green → growth-strategist (growth/upward)
 * - `warning` = orange → content-planner (content production / warm)
 *
 * Phase E writers get added here when their AGENT.md files land. Unknown
 * agent types fall back to a deterministic hash-based gradient so new
 * AGENT.md entries render reasonably before we pick a semantic hue.
 */

export interface AgentAccent {
  /** Accent color for card stripe + avatar, sourced from --sf-* tokens. */
  solid: string;
  /** Soft tint for hovered surfaces and status pills. */
  soft: string;
  /** Ink color for contrast-compatible text on a `soft` tint. */
  ink: string;
  /** Badge variant paired with this accent (for the "agent type" chip). */
  badgeVariant: BadgeVariant;
}

const COORDINATOR: AgentAccent = {
  solid: 'var(--sf-accent)',
  soft: 'var(--sf-accent-light)',
  ink: 'var(--sf-link)',
  badgeVariant: 'accent',
};
const GROWTH: AgentAccent = {
  solid: 'var(--sf-success)',
  soft: 'var(--sf-success-light)',
  ink: 'var(--sf-success-ink)',
  badgeVariant: 'success',
};
const CONTENT: AgentAccent = {
  solid: 'var(--sf-warning)',
  soft: 'var(--sf-warning-light)',
  ink: 'var(--sf-warning-ink)',
  badgeVariant: 'warning',
};

const ACCENTS: Record<string, AgentAccent> = {
  coordinator: COORDINATOR,
  'growth-strategist': GROWTH,
  'content-planner': CONTENT,
};

export function accentForAgentType(agentType: string): AgentAccent | null {
  return ACCENTS[agentType] ?? null;
}

/**
 * Deterministic gradient for an agent avatar. Semantic accents render as a
 * two-step gradient off their brand color; unknown agent types fall back
 * to a hash-seeded hue so new AGENT.md files don't look broken.
 */
export function avatarGradientForAgentType(agentType: string): string {
  const accent = accentForAgentType(agentType);
  if (accent) {
    // Blend from the soft tint into the solid color so the avatar reads
    // as the agent's brand color without being a flat block.
    return `linear-gradient(135deg, ${accent.soft}, ${accent.solid})`;
  }
  let hash = 0;
  for (let i = 0; i < agentType.length; i += 1) {
    hash = (hash * 31 + agentType.charCodeAt(i)) | 0;
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 48) % 360;
  return `linear-gradient(135deg, hsl(${h1} 68% 72%), hsl(${h2} 62% 58%))`;
}
