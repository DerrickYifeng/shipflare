'use client';

import { TodoCard } from './todo-card';
import type { TodoItem } from '@/hooks/use-today';

interface TodoListProps {
  items: TodoItem[];
  onApprove: (id: string) => void;
  onSkip: (id: string) => void;
  onEdit: (id: string, body: string) => void;
  onReschedule: (id: string, scheduledFor: string) => void;
}

const priorityGroupLabel: Record<string, string> = {
  time_sensitive: 'Time-sensitive',
  scheduled: 'Scheduled for today',
  optional: 'Optional',
};

const priorityGroupIcon: Record<string, string> = {
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
}: TodoListProps) {
  // Group by priority
  const groups = ['time_sensitive', 'scheduled', 'optional'] as const;

  return (
    <div className="flex flex-col gap-6">
      {groups.map((priority) => {
        const groupItems = items.filter((i) => i.priority === priority);
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
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
