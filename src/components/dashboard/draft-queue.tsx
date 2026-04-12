'use client';

import { useDrafts } from '@/hooks/use-drafts';
import { DraftCard } from './draft-card';
import { Skeleton } from '@/components/ui/skeleton';

export function DraftQueue() {
  const { drafts, isLoading, approve, skip } = useDrafts();

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
        <p className="text-[15px] text-sf-text-secondary mb-1">No pending drafts</p>
        <p className="text-[13px] text-sf-text-tertiary">
          Drafts appear here after discovery finds relevant threads.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {drafts.map((draft) => (
        <DraftCard
          key={draft.id}
          draft={draft}
          onApprove={approve}
          onSkip={skip}
        />
      ))}
    </div>
  );
}
