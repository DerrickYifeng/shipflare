'use client';

import { useState, useMemo } from 'react';
import { useDrafts, type DraftSource } from '@/hooks/use-drafts';
import { DraftCard } from './draft-card';
import { Skeleton } from '@/components/ui/skeleton';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { ShortcutsHelp, type ShortcutBinding } from '@/components/ui/shortcuts-help';

const SOURCE_FILTERS: Array<{ value: DraftSource | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'monitor', label: 'Scheduled replies' },
  { value: 'calendar', label: 'Scheduled posts' },
  { value: 'engagement', label: 'Engage with my audience' },
  { value: 'discovery', label: 'Community threads' },
];

export function DraftQueue() {
  const { drafts, isLoading, approve, skip, retry } = useDrafts();
  const [filter, setFilter] = useState<DraftSource | 'all'>('all');
  const [activeIndex, setActiveIndex] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);

  const filtered = useMemo(() => {
    if (filter === 'all') return drafts;
    return drafts.filter((d) => d.source === filter);
  }, [drafts, filter]);

  // Count per source for tab badges
  const counts = useMemo(() => {
    const map: Record<string, number> = { all: drafts.length };
    for (const d of drafts) {
      map[d.source] = (map[d.source] ?? 0) + 1;
    }
    return map;
  }, [drafts]);

  const shortcutBindings: ShortcutBinding[] = useMemo(
    () => [
      { keys: 'j', label: 'Next draft' },
      { keys: 'k', label: 'Previous draft' },
      { keys: 'a', label: 'Approve current draft' },
      { keys: 's', label: 'Skip current draft' },
      { keys: '?', label: 'Show this help' },
    ],
    [],
  );

  useKeyboardShortcuts(
    {
      j: () =>
        setActiveIndex((i) =>
          Math.min(i + 1, Math.max(filtered.length - 1, 0)),
        ),
      k: () => setActiveIndex((i) => Math.max(i - 1, 0)),
      a: () => {
        const target = filtered[activeIndex];
        if (target) void approve(target.id);
      },
      s: () => {
        const target = filtered[activeIndex];
        if (target) void skip(target.id);
      },
      '?': () => setHelpOpen(true),
    },
    [filtered, activeIndex, approve, skip],
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (drafts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-[17px] tracking-[-0.374px] text-sf-text-secondary mb-1">No pending drafts</p>
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary">
          Drafts appear here after discovery finds relevant threads.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Source filter tabs */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {SOURCE_FILTERS.map((f) => {
          const count = counts[f.value] ?? 0;
          if (f.value !== 'all' && count === 0) return null;
          const active = filter === f.value;
          return (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={`px-3 py-1.5 rounded-full text-[12px] tracking-[-0.12px] font-medium transition-colors duration-200 whitespace-nowrap ${
                active
                  ? 'bg-sf-accent text-white'
                  : 'bg-sf-bg-secondary text-sf-text-secondary hover:text-sf-text-primary'
              }`}
            >
              {f.label}
              {count > 0 && (
                <span className={`ml-1.5 ${active ? 'opacity-80' : 'opacity-60'}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Draft list */}
      <div className="flex flex-col gap-2">
        {filtered.map((draft, idx) => (
          <DraftCard
            key={draft.id}
            draft={draft}
            onApprove={approve}
            onSkip={skip}
            onRetry={retry}
            isActive={idx === activeIndex}
          />
        ))}
      </div>

      <ShortcutsHelp
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        bindings={shortcutBindings}
      />
    </div>
  );
}
