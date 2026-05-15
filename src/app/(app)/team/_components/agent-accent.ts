import type { BadgeVariant } from '@/components/ui/badge';

/**
 * Per-agent accents. Shared between the AI-team redesign components
 * (agent-dot, left-rail, delegation-card, agent-workspace), the
 * TeamMemberPage (hero avatar), and any place that needs a consistent
 * color, monogram, and role code for an agent.
 *
 * Keys are the PUBLIC (post-redaction) labels the founder sees — e.g.
 * 'Team Lead', 'Social Media Manager'. The team API redacts raw agent
 * types via `redact-for-client.ts` before they reach the UI, so the
 * accent map keys on the same labels the components already render.
 *
 * The Team Lead accent maps onto existing `--sf-*` tokens. The Social
 * Media Manager accent adopts an iOS system hue by literal hex — there's
 * no matching semantic token in globals.css, and the plan calls out
 * that we keep the inline hex value right here rather than inventing
 * a new CSS variable.
 *
 * Unknown agent labels fall back to a deterministic hash-based gradient
 * so new AGENT.md entries still render reasonably. Admin / dev surfaces
 * that intentionally render raw agent types (e.g. `team-runs`) get the
 * same fallback — they're not founder-facing so the neutral gradient is
 * acceptable.
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
  /** Uppercase role code rendered under the agent's name in the left rail. */
  code: string;
  /** Single-letter monogram used by `AgentDot`. */
  initial: string;
  /** Concrete hex value for places where a CSS var won't do (SVG, gradients). */
  colorHex: string;
}

const COORDINATOR: AgentAccent = {
  solid: 'var(--sf-fg-1)',
  soft: 'var(--sf-bg-tertiary)',
  ink: 'var(--sf-fg-1)',
  badgeVariant: 'default',
  code: 'CHIEF MARKETING OFFICER',
  initial: 'C',
  colorHex: '#1d1d1f',
};
const COMMUNITY: AgentAccent = {
  solid: '#af52de',
  soft: '#f3e5fa',
  ink: '#803aa7',
  badgeVariant: 'accent',
  code: 'SOCIAL MEDIA MANAGER',
  initial: 'M',
  colorHex: '#af52de',
};

const ACCENTS: Record<string, AgentAccent> = {
  'Team Lead': COORDINATOR,
  'Social Media Manager': COMMUNITY,
};

export function accentForAgentType(agentType: string): AgentAccent | null {
  return ACCENTS[agentType] ?? null;
}

/**
 * Concrete hex for an agent's brand color, suitable for inline SVG fills,
 * multi-stop gradients, or the `AgentDot` background. Returns a neutral
 * grey for unknown agent types so callers don't need their own fallback.
 */
export function colorHexForAgentType(agentType: string): string {
  return accentForAgentType(agentType)?.colorHex ?? '#8e8e93';
}

/**
 * Uppercase role code for the left rail row — "CHIEF MARKETING OFFICER",
 * "SOCIAL MEDIA MANAGER", etc. Unknown agent types surface the raw
 * agent_type as a sensible placeholder until we mint a code for it.
 */
export function roleCodeForAgentType(agentType: string): string {
  return accentForAgentType(agentType)?.code ?? agentType.toUpperCase();
}

/**
 * Single-letter monogram. Prefers the curated initial (so we can
 * disambiguate 'Team Lead' → "C" (for CMO) and 'Social Media Manager'
 * → "M") and falls back to the first letter of the display name, then
 * the first letter of the agent label.
 */
export function initialForAgent(agentType: string, displayName: string): string {
  const curated = accentForAgentType(agentType)?.initial;
  if (curated) return curated;
  const trimmed = displayName.trim();
  if (trimmed.length > 0) return trimmed.charAt(0).toUpperCase();
  return agentType.charAt(0).toUpperCase() || '?';
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
