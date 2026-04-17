'use client';

import { useMemo, useState } from 'react';
import { useProgressiveStream } from '@/hooks/use-progressive-stream';
import { SourceChip, type SourceChipData } from './source-chip';

interface SourceProgressRailProps {
  sources: Array<{ platform: string; source: string }>;
  scanRunId: string | null;
  onFilterChange: (source: string | null) => void;
  onRetrySource: (platform: string, source: string) => void;
}

/**
 * Horizontal rail of per-source status chips. Hidden entirely until a scan
 * has been started (no `scanRunId`) so it doesn't hold dead space on first
 * visit. The live state map keys are `"{platform}:{source}"` to match the
 * backend envelope's `itemId`.
 */
export function SourceProgressRail({
  sources,
  scanRunId,
  onFilterChange,
  onRetrySource,
}: SourceProgressRailProps) {
  const { items } = useProgressiveStream<SourceChipData>('discovery');
  const [filter, setFilter] = useState<string | null>(null);

  const chips = useMemo(() => {
    return sources.map((s) => {
      const id = `${s.platform}:${s.source}`;
      return { id, ...s, snapshot: items.get(id) };
    });
  }, [sources, items]);

  if (!scanRunId || chips.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Discovery source progress"
      className="flex flex-wrap gap-1.5 mb-4"
    >
      {chips.map((c) => (
        <SourceChip
          key={c.id}
          id={c.id}
          source={c.source}
          platform={c.platform}
          snapshot={c.snapshot}
          isFiltered={filter === c.id}
          onFilter={() => {
            const next = filter === c.id ? null : c.id;
            setFilter(next);
            onFilterChange(next);
          }}
          onRetry={() => onRetrySource(c.platform, c.source)}
        />
      ))}
    </div>
  );
}
