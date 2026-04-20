'use client';

import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import type { ItemSnapshot } from '@/hooks/use-progressive-stream';

interface PipelineHealthPillProps {
  items: Map<string, ItemSnapshot>;
  total: number;
}

/**
 * Compact status pill summarizing how many plan slots are ready / in flight /
 * failed versus the total expected count. Hidden when `total` is 0 so it
 * doesn't show a zero state before a plan exists.
 */
export function PipelineHealthPill({ items, total }: PipelineHealthPillProps) {
  const counts = useMemo(() => {
    let ready = 0;
    let inFlight = 0;
    let failed = 0;
    for (const s of items.values()) {
      if (s.state === 'ready') ready++;
      else if (s.state === 'failed') failed++;
      else inFlight++;
    }
    return { ready, inFlight, failed };
  }, [items]);

  if (total === 0) return null;

  const variant: 'danger' | 'warning' | 'success' =
    counts.failed > 0
      ? 'danger'
      : counts.inFlight > 0
        ? 'warning'
        : 'success';

  return (
    <Badge variant={variant}>
      <span aria-live="polite">
        {counts.ready}/{total} ready
        {counts.inFlight > 0 && ` · ${counts.inFlight} in flight`}
        {counts.failed > 0 && ` · ${counts.failed} failed`}
      </span>
    </Badge>
  );
}
