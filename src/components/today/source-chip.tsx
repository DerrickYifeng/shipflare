'use client';

import type { ReactNode } from 'react';
import type { ItemSnapshot } from '@/hooks/use-progressive-stream';

export interface SourceChipData {
  found?: number;
  aboveGate?: number;
  reason?: string;
}

interface SourceChipProps {
  id: string;
  source: string;
  platform: string;
  snapshot: ItemSnapshot<SourceChipData> | undefined;
  onRetry: () => void;
  onFilter: () => void;
  isFiltered: boolean;
}

const baseClass =
  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium transition-colors duration-200';

export function SourceChip({
  id,
  source,
  snapshot,
  onRetry,
  onFilter,
  isFiltered,
}: SourceChipProps) {
  const state = snapshot?.state ?? 'queued';

  let variantClass = '';
  let content: ReactNode = source;

  if (state === 'queued') {
    variantClass = 'bg-sf-bg-secondary text-sf-text-tertiary';
    content = <>{source}</>;
  } else if (state === 'searching') {
    variantClass = 'bg-sf-bg-secondary text-sf-text-secondary';
    content = (
      <>
        <span
          aria-hidden
          className="w-1.5 h-1.5 rounded-full bg-sf-accent animate-pulse"
        />
        {source}
      </>
    );
  } else if (state === 'searched') {
    variantClass = 'bg-sf-success-light text-[#248a3d]';
    const aboveGate = snapshot?.data?.aboveGate ?? 0;
    content = (
      <>
        {source}
        <span className="font-mono tabular-nums">{aboveGate}</span>
      </>
    );
  } else if (state === 'failed') {
    variantClass = 'bg-sf-error-light text-sf-error';
    content = <>{source} · failed</>;
  } else {
    // drafting / ready / other — treat as in-flight visually
    variantClass = 'bg-sf-bg-secondary text-sf-text-secondary';
  }

  const isFailed = state === 'failed';

  return (
    <button
      type="button"
      onClick={isFailed ? onRetry : onFilter}
      aria-pressed={isFiltered}
      aria-label={
        isFailed
          ? `Retry search for ${source}`
          : `Filter replies by ${source}`
      }
      data-source-id={id}
      data-state={state}
      title={snapshot?.data?.reason ?? source}
      className={`${baseClass} ${variantClass} ${
        isFiltered ? 'ring-2 ring-sf-accent' : ''
      }`}
    >
      {content}
    </button>
  );
}
