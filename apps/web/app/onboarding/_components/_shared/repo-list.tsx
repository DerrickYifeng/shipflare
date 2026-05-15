// RepoList — white card listing repos after GitHub authorization.
// Green-tinted header row + search input + scrollable list.

import { useMemo, useState } from 'react';
import { OnbMono } from './onb-mono';
import { RepoRow, type RepoRowData } from './repo-row';
import { Search } from '../icons';

interface RepoListProps {
  repos: RepoRowData[];
  username: string | null;
  selectedFullName: string | null;
  onSelect: (repo: RepoRowData) => void;
  searchPlaceholder: string;
}

export function RepoList({
  repos,
  username,
  selectedFullName,
  onSelect,
  searchPlaceholder,
}: RepoListProps) {
  const [q, setQ] = useState('');
  const filtered = useMemo(
    () =>
      repos.filter(
        (r) => !q || r.fullName.toLowerCase().includes(q.toLowerCase()),
      ),
    [repos, q],
  );

  return (
    <div
      style={{
        background: 'var(--sf-bg-secondary)',
        borderRadius: 12,
        boxShadow: 'var(--sf-shadow-card)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderBottom: '1px solid rgba(0,0,0,0.06)',
          background: 'rgba(52,199,89,0.06)',
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--sf-success)',
          }}
        />
        <OnbMono color="var(--sf-success-ink)">
          Connected{username ? ` · @${username}` : ''}
        </OnbMono>
        <span style={{ flex: 1 }} />
        <OnbMono>{filtered.length} recent repos</OnbMono>
      </div>
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid rgba(0,0,0,0.06)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 32,
            padding: '0 12px',
            background: 'var(--sf-bg-primary)',
            borderRadius: 8,
          }}
        >
          <Search size={13} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontFamily: 'inherit',
              fontSize: 13,
              letterSpacing: '-0.16px',
              color: 'var(--sf-fg-1)',
            }}
          />
        </div>
      </div>
      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
        {filtered.length === 0 && (
          <div
            style={{
              padding: '28px 16px',
              textAlign: 'center',
              fontSize: 13,
              color: 'var(--sf-fg-4)',
              letterSpacing: '-0.16px',
            }}
          >
            No repositories match &quot;{q}&quot;.
          </div>
        )}
        {filtered.map((r) => (
          <RepoRow
            key={r.fullName}
            repo={r}
            selected={selectedFullName === r.fullName}
            onSelect={() => onSelect(r)}
          />
        ))}
      </div>
    </div>
  );
}
