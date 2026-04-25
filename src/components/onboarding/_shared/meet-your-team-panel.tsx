'use client';

// Meet-your-team panel. Read-only preview of the AI team that will (or
// already has been) provisioned for the user's product. Shown on Stage 7
// as a confidence-building close-out — not an editor. No add/remove/rename.
//
// Two modes:
//   - `members` present  → render the actual team_members rows
//   - `members` absent   → render the preset preview + "ready after you ship"
//                          hint, so the card is still meaningful for users
//                          whose team was not yet provisioned (the primary
//                          provisioning happens in /api/onboarding/commit,
//                          i.e. AFTER this panel renders in the same flow).

import type { ReactNode } from 'react';
import { COPY } from '../_copy';
import type {
  AgentType,
  DisplayNameMap,
} from '@/lib/team-presets';

export interface MeetYourTeamMember {
  agentType: AgentType | string;
  displayName: string;
}

interface MeetYourTeamPanelProps {
  /**
   * The actual members in the team. When omitted, the panel renders the
   * `roster` as a preview with the "ready after you ship" hint.
   */
  members?: MeetYourTeamMember[];
  /** The roster the provisioner will seed, used in preview mode. */
  roster: AgentType[];
  /**
   * Optional display-name override for preview mode. Falls back to the
   * shared DEFAULT_DISPLAY_NAMES map when absent.
   */
  displayNames?: Partial<DisplayNameMap>;
}

const ROLE_DESCRIPTION: Record<string, string> = {
  coordinator: 'Runs the team and keeps work moving.',
  'growth-strategist': 'Shapes your positioning and long-term arc.',
  'content-planner': 'Builds the weekly plan from your strategy.',
  'post-writer': 'Drafts posts for X and Reddit, tuned to each platform.',
  'community-manager': 'Monitors conversations and drafts replies.',
};

function roleDescriptionFor(agentType: string): string {
  return ROLE_DESCRIPTION[agentType] ?? 'Part of your team.';
}

function avatarGradient(agentType: string): string {
  let hash = 0;
  for (let i = 0; i < agentType.length; i += 1) {
    hash = (hash * 31 + agentType.charCodeAt(i)) | 0;
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 48) % 360;
  return `linear-gradient(135deg, hsl(${h1} 68% 72%), hsl(${h2} 62% 58%))`;
}

function initials(displayName: string): string {
  const parts = displayName.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function MeetYourTeamPanel({
  members,
  roster,
  displayNames,
}: MeetYourTeamPanelProps): ReactNode {
  const previewMode = !members || members.length === 0;

  // Build the rendered member list. In preview mode, synthesize from roster.
  const rendered: MeetYourTeamMember[] = previewMode
    ? roster.map((agentType) => ({
        agentType,
        displayName:
          displayNames?.[agentType as keyof DisplayNameMap] ??
          DEFAULT_LABELS[agentType] ??
          agentType,
      }))
    : members ?? [];

  return (
    <section
      aria-labelledby="meet-your-team-heading"
      data-testid="meet-your-team-panel"
      style={{
        marginTop: 18,
        marginBottom: 18,
        background: 'var(--sf-bg-secondary)',
        borderRadius: 12,
        padding: '18px 20px',
        boxShadow: 'var(--sf-shadow-card)',
      }}
    >
      <header style={{ marginBottom: 12 }}>
        <h2
          id="meet-your-team-heading"
          style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 500,
            letterSpacing: '-0.16px',
            color: 'var(--sf-fg-1)',
          }}
        >
          {COPY.stage7.meetYourTeam.heading}
        </h2>
        <p
          style={{
            margin: '4px 0 0',
            fontSize: 12.5,
            letterSpacing: '-0.14px',
            color: 'var(--sf-fg-3)',
          }}
        >
          {previewMode
            ? COPY.stage7.meetYourTeam.previewNote
            : COPY.stage7.meetYourTeam.sub}
        </p>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fit, minmax(160px, 1fr))`,
          gap: 10,
        }}
      >
        {rendered.map((m) => (
          <MemberCard
            key={`${m.agentType}-${m.displayName}`}
            agentType={String(m.agentType)}
            displayName={m.displayName}
          />
        ))}
      </div>
    </section>
  );
}

interface MemberCardProps {
  agentType: string;
  displayName: string;
}

function MemberCard({ agentType, displayName }: MemberCardProps): ReactNode {
  return (
    <div
      style={{
        background: 'var(--sf-bg-primary)',
        borderRadius: 10,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        border: '1px solid var(--sf-border-1)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 24,
            height: 24,
            borderRadius: '50%',
            background: avatarGradient(agentType),
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
            fontWeight: 600,
            color: 'white',
            letterSpacing: '-0.1px',
            flexShrink: 0,
          }}
        >
          {initials(displayName)}
        </span>
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            letterSpacing: '-0.15px',
            color: 'var(--sf-fg-1)',
          }}
        >
          {displayName}
        </span>
      </div>
      <p
        style={{
          margin: 0,
          fontSize: 11.5,
          lineHeight: 1.4,
          color: 'var(--sf-fg-3)',
        }}
      >
        {roleDescriptionFor(agentType)}
      </p>
    </div>
  );
}

const DEFAULT_LABELS: Record<string, string> = {
  coordinator: 'Chief of Staff',
  'growth-strategist': 'Head of Growth',
  'content-planner': 'Head of Content',
  'post-writer': 'Post Writer',
  'community-manager': 'Community Manager',
};
