'use client';

import { useMemo } from 'react';
import { TodoCard } from './todo-card';
import type { TodoItem } from '@/hooks/use-today';

interface TodoListProps {
  items: TodoItem[];
  onApprove: (id: string) => void;
  onSkip: (id: string) => void;
  onEdit: (id: string, body: string) => void;
  onReschedule: (id: string, scheduledFor: string) => void;
  /** The id of the keyboard-navigation focus, highlighted with a ring. */
  activeId?: string | null;
  /** The id of the item whose edit mode was triggered via the `e` shortcut. */
  editingId?: string | null;
  /** Called when the externally-triggered edit finishes (save / cancel). */
  onEditDone?: () => void;
}

type Priority = 'time_sensitive' | 'scheduled' | 'optional';

const GROUP_ORDER: readonly Priority[] = ['time_sensitive', 'scheduled', 'optional'] as const;

const priorityGroupLabel: Record<Priority, string> = {
  time_sensitive: 'Time-sensitive',
  scheduled: 'Scheduled for today',
  optional: 'Optional',
};

const priorityGroupIcon: Record<Priority, string> = {
  time_sensitive: '\u26A1',
  scheduled: '\uD83D\uDCC5',
  optional: '\uD83D\uDCA1',
};

export function TodoList({
  items,
  onApprove,
  onSkip,
  onEdit,
  onReschedule,
  activeId,
  editingId,
  onEditDone,
}: TodoListProps) {
  // Group by priority in a single pass. Memoized so unrelated parent re-renders
  // (e.g. FirstRun state flipping) don't reshuffle children.
  const grouped = useMemo(() => {
    const buckets: Record<Priority, TodoItem[]> = {
      time_sensitive: [],
      scheduled: [],
      optional: [],
    };
    for (const item of items) {
      const bucket = buckets[item.priority as Priority];
      if (bucket) bucket.push(item);
    }
    return buckets;
  }, [items]);

  return (
    <div className="flex flex-col gap-6">
      {GROUP_ORDER.map((priority) => {
        const groupItems = grouped[priority];
        if (groupItems.length === 0) return null;

        return (
          <div key={priority}>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[14px]">
                {priorityGroupIcon[priority]}
              </span>
              <h3 className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-secondary uppercase">
                {priorityGroupLabel[priority]}
              </h3>
              <span className="text-[12px] tracking-[-0.12px] font-mono text-sf-text-tertiary">
                {groupItems.length}
              </span>
            </div>
            <div className="flex flex-col gap-3">
              {groupItems.map((item) => (
                <TodoCard
                  key={item.id}
                  item={item}
                  onApprove={onApprove}
                  onSkip={onSkip}
                  onEdit={onEdit}
                  onReschedule={onReschedule}
                  isActive={item.id === activeId}
                  forceEditing={item.id === editingId}
                  onEditDone={onEditDone}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
