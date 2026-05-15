// RepoRow — single repository row in the Stage 1 GitHub repo list.
// Selected state: rgba(0,113,227,0.06) bg + 3px accent left border.

import { useState } from 'react';
import { Check, GitHub } from '../icons';
import type { GitHubRepo } from '@/types/code-scanner';

export interface RepoRowData extends GitHubRepo {
  /** Computed client-side: user-relative "2h ago", "yesterday", etc. */
  updatedLabel?: string;
  /** Optional flag — UI chip badge. */
  recommended?: boolean;
  /** Optional flag — private repo chip. */
  priv?: boolean;
}

interface RepoRowProps {
  repo: RepoRowData;
  selected: boolean;
  onSelect: () => void;
}

export function RepoRow({ repo, selected, onSelect }: RepoRowProps) {
  const [hover, setHover] = useState(false);
  const background = selected
    ? 'rgba(0,113,227,0.06)'
    : hover
      ? 'rgba(0,0,0,0.02)'
      : 'transparent';
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: '100%',
        textAlign: 'left',
        border: 'none',
        cursor: 'pointer',
        background,
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        borderLeft: `3px solid ${selected ? 'var(--sf-accent)' : 'transparent'}`,
        fontFamily: 'inherit',
        transition: 'background 150ms',
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          background: selected ? 'var(--sf-accent)' : 'var(--sf-bg-primary)',
          color: selected ? '#fff' : 'var(--sf-fg-2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {selected ? <Check size={13} /> : <GitHub />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontFamily: 'var(--sf-font-mono)',
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--sf-fg-1)',
              letterSpacing: '-0.12px',
            }}
          >
            {repo.fullName}
          </span>
          {repo.priv && <RepoChip tone="grey">Private</RepoChip>}
          {repo.recommended && <RepoChip tone="accent">Recommended</RepoChip>}
        </div>
        {repo.description && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--sf-fg-3)',
              letterSpacing: '-0.12px',
              marginTop: 2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {repo.description}
          </div>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 2,
          fontFamily: 'var(--sf-font-mono)',
          fontSize: 10,
          color: 'var(--sf-fg-4)',
          letterSpacing: '-0.08px',
          flexShrink: 0,
        }}
      >
        {repo.language && <span>{repo.language}</span>}
        {repo.updatedLabel && (
          <span style={{ color: 'rgba(0,0,0,0.32)' }}>{repo.updatedLabel}</span>
        )}
      </div>
    </button>
  );
}

function RepoChip({
  tone,
  children,
}: {
  tone: 'grey' | 'accent';
  children: string;
}) {
  const style =
    tone === 'accent'
      ? { background: 'var(--sf-accent-light)', color: 'var(--sf-accent)' }
      : { background: 'rgba(0,0,0,0.06)', color: 'var(--sf-fg-3)' };
  return (
    <span
      style={{
        padding: '1px 6px',
        borderRadius: 4,
        fontSize: 10,
        fontFamily: 'var(--sf-font-mono)',
        letterSpacing: '-0.08px',
        textTransform: 'uppercase',
        fontWeight: 500,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
