'use client';

import { useMemo } from 'react';
import { useProgressiveStream } from '@/hooks/use-progressive-stream';
import { ReplyCard } from './reply-card';
import type { TodoItem } from '@/hooks/use-today';

interface ReplyRailProps {
  replyItems: TodoItem[];
  sourceFilter: string | null;
  onApprove: (id: string) => void;
  onSkip: (id: string) => void;
  onEdit: (id: string, body: string) => void;
  activeId?: string | null;
  editingId?: string | null;
  onEditDone?: () => void;
}

/**
 * Dedicated rail for time-sensitive reply_thread todos. Filters by
 * `sourceFilter` when a SourceChip has been toggled (match is on
 * `community`, e.g. "r/foo"). Subscribes to the reply progressive stream so
 * future live-hydration can render shells before the server round-trip
 * completes, even though today we only render persisted items.
 */
export function ReplyRail({
  replyItems,
  sourceFilter,
  onApprove,
  onSkip,
  onEdit,
  activeId,
  editingId,
  onEditDone,
}: ReplyRailProps) {
  const { items: live } = useProgressiveStream<{
    draftId?: string;
    previewBody?: string;
  }>('reply');

  const filtered = useMemo(() => {
    if (!sourceFilter) return replyItems;
    // SourceChip ids are `"{platform}:{source}"`, e.g. "reddit:r/startups".
    // TodoItem.community carries the raw source ("r/startups") — do a
    // substring check so either shape matches.
    return replyItems.filter(
      (r) => r.community && sourceFilter.includes(r.community),
    );
  }, [replyItems, sourceFilter]);

  if (filtered.length === 0 && live.size === 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="p-4 mb-4 rounded-[var(--radius-sf-md)] bg-sf-bg-secondary text-[14px] tracking-[-0.224px] text-sf-text-tertiary"
      >
        Replies stream in as target sources are scanned.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 mb-6" data-reply-rail>
      {filtered.map((item) => (
        <ReplyCard
          key={item.id}
          item={item}
          onApprove={onApprove}
          onSkip={onSkip}
          onEdit={onEdit}
          isActive={item.id === activeId}
          forceEditing={item.id === editingId}
          onEditDone={onEditDone}
        />
      ))}
    </div>
  );
}
