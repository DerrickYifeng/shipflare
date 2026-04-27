import type { BadgeVariant } from '@/components/ui/badge';

/**
 * Per-agent-type accents. Shared between the AI-team redesign components
 * (agent-dot, left-rail, delegation-card, agent-workspace), the
 * TeamMemberPage (hero avatar), and any place that needs a consistent
 * color, monogram, and role code for an agent.
 *
 * The base triad (coordinator / growth-strategist / content-planner)
 * maps onto existing `--sf-*` tokens. The writer + community pair adopts
 * iOS system hues by literal hex — they have no matching semantic token in
 * globals.css, and the plan calls out that we keep the inline hex
 * values right here rather than inventing new CSS variables.
 *
 * Unknown agent types fall back to a deterministic hash-based gradient
 * so new AGENT.md entries still render reasonably.
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
  code: 'CHIEF OF STAFF',
  initial: 'L',
  colorHex: '#1d1d1f',
};
const GROWTH: AgentAccent = {
  solid: 'var(--sf-success)',
  soft: 'var(--sf-success-light)',
  ink: 'var(--sf-success-ink)',
  badgeVariant: 'success',
  code: 'GROWTH',
  initial: 'G',
  colorHex: '#248a3d',
};
const CONTENT: AgentAccent = {
  solid: 'var(--sf-warning)',
  soft: 'var(--sf-warning-light)',
  ink: 'var(--sf-warning-ink)',
  badgeVariant: 'warning',
  code: 'CONTENT',
  initial: 'P',
  colorHex: '#c67a05',
};
const POST_WRITER: AgentAccent = {
  solid: '#5e5ce6',
  soft: '#ecebfb',
  ink: '#3f3dc0',
  badgeVariant: 'accent',
  code: 'POST WRITER',
  initial: 'W',
  colorHex: '#5e5ce6',
};
const COMMUNITY: AgentAccent = {
  solid: '#af52de',
  soft: '#f3e5fa',
  ink: '#803aa7',
  badgeVariant: 'accent',
  code: 'COMMUNITY',
  initial: 'M',
  colorHex: '#af52de',
};

const ACCENTS: Record<string, AgentAccent> = {
  coordinator: COORDINATOR,
  'growth-strategist': GROWTH,
  'content-planner': CONTENT,
  'post-writer': POST_WRITER,
  'community-manager': COMMUNITY,
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
 * Uppercase role code for the left rail row — "CHIEF OF STAFF",
 * "X WRITER", etc. Unknown agent types surface the raw agent_type as a
 * sensible placeholder until we mint a code for it.
 */
export function roleCodeForAgentType(agentType: string): string {
  return accentForAgentType(agentType)?.code ?? agentType.toUpperCase();
}

/**
 * Single-letter monogram. Prefers the curated initial (so we can
 * disambiguate `coordinator` → "L" and `content-planner` → "P") and
 * falls back to the first letter of the display name, then the first
 * letter of the agent type.
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
