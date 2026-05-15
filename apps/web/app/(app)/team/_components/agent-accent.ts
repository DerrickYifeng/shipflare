/**
 * Per-role accents (color, monogram, role code) used across the team page.
 *
 * Ported from Railway's src/app/(app)/team/_components/agent-accent.ts.
 * Railway keys the map on display names ('Team Lead', 'Social Media
 * Manager'); CF keys on the slugs from `@shipflare/shared`'s ROLE_REGISTRY
 * so call sites can pass `roster.role` (cmo / social-media-manager / …)
 * directly without translating to a label.
 *
 * Unknown role slugs get a deterministic hash-seeded gradient so newly
 * added role entries render reasonably until they get a curated accent.
 */

export interface AgentAccent {
  /** Accent color for stripe / avatar — references --sf-* tokens. */
  solid: string;
  /** Soft tint for hovered surfaces and status pills. */
  soft: string;
  /** Ink color contrast-compatible with `soft`. */
  ink: string;
  /** Uppercase role code rendered under the agent's name in the left rail. */
  code: string;
  /** Single-letter monogram used by `AgentDot`. */
  initial: string;
  /** Concrete hex value where a CSS var won't do (SVG, gradients). */
  colorHex: string;
}

const CMO: AgentAccent = {
  solid: "var(--sf-fg-1)",
  soft: "var(--sf-bg-tertiary)",
  ink: "var(--sf-fg-1)",
  code: "CHIEF MARKETING OFFICER",
  initial: "C",
  colorHex: "#1d1d1f",
};

const HEAD_OF_GROWTH: AgentAccent = {
  solid: "#0a84ff",
  soft: "#e8f1ff",
  ink: "#0353c5",
  code: "HEAD OF GROWTH",
  initial: "G",
  colorHex: "#0a84ff",
};

const SOCIAL_MEDIA_MANAGER: AgentAccent = {
  solid: "#af52de",
  soft: "#f3e5fa",
  ink: "#803aa7",
  code: "SOCIAL MEDIA MANAGER",
  initial: "M",
  colorHex: "#af52de",
};

const COPYWRITER: AgentAccent = {
  solid: "#ff9f0a",
  soft: "#fff3df",
  ink: "#a85c00",
  code: "COPYWRITER",
  initial: "W",
  colorHex: "#ff9f0a",
};

const BRAND_ANALYST: AgentAccent = {
  solid: "#30b0c7",
  soft: "#e1f4f7",
  ink: "#1b6f7e",
  code: "BRAND ANALYST",
  initial: "B",
  colorHex: "#30b0c7",
};

const COMMUNITY_MANAGER: AgentAccent = {
  solid: "#34c759",
  soft: "#e6f7eb",
  ink: "#1f7a38",
  code: "COMMUNITY MANAGER",
  initial: "C",
  colorHex: "#34c759",
};

const ACCENTS: Record<string, AgentAccent> = {
  cmo: CMO,
  "head-of-growth": HEAD_OF_GROWTH,
  "social-media-manager": SOCIAL_MEDIA_MANAGER,
  copywriter: COPYWRITER,
  "brand-analyst": BRAND_ANALYST,
  "community-manager": COMMUNITY_MANAGER,
};

export function accentForRole(role: string): AgentAccent | null {
  return ACCENTS[role] ?? null;
}

export function colorHexForRole(role: string): string {
  return accentForRole(role)?.colorHex ?? "#8e8e93";
}

export function roleCodeForRole(role: string, displayName: string): string {
  return accentForRole(role)?.code ?? displayName.toUpperCase();
}

export function initialForRole(role: string, displayName: string): string {
  const curated = accentForRole(role)?.initial;
  if (curated) return curated;
  const trimmed = displayName.trim();
  if (trimmed.length > 0) return trimmed.charAt(0).toUpperCase();
  return role.charAt(0).toUpperCase() || "?";
}

/**
 * Deterministic gradient for an agent avatar. Curated roles return a
 * two-step gradient off their brand color; unknown roles fall back to a
 * hash-seeded hue so new roster entries don't look broken.
 */
export function avatarGradientForRole(role: string): string {
  const accent = accentForRole(role);
  if (accent) {
    return `linear-gradient(135deg, ${accent.soft}, ${accent.solid})`;
  }
  let hash = 0;
  for (let i = 0; i < role.length; i += 1) {
    hash = (hash * 31 + role.charCodeAt(i)) | 0;
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 48) % 360;
  return `linear-gradient(135deg, hsl(${h1} 68% 72%), hsl(${h2} 62% 58%))`;
}
