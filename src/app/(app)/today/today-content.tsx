'use client';

import { useState, useCallback } from 'react';
import { useToday } from '@/hooks/use-today';
import { TodoList } from '@/components/today/todo-list';
import { CompletionState } from '@/components/today/completion-state';
import { EmptyState } from '@/components/today/empty-state';
import { FirstRun } from '@/components/today/first-run';

interface TodayContentProps {
  isFirstRun: boolean;
}

export function TodayContent({ isFirstRun }: TodayContentProps) {
  const { items, stats, isLoading, approve, skip, edit, reschedule, mutate } =
    useToday();
  const [showFirstRun, setShowFirstRun] = useState(isFirstRun);

  const handleItemsReady = useCallback(() => {
    setShowFirstRun(false);
    mutate();
  }, [mutate]);

  // First-run experience
  if (showFirstRun && items.length === 0) {
    return <FirstRun onItemsReady={handleItemsReady} />;
  }

  if (isLoading) {
    return null; // loading.tsx handles this
  }

  // Active: items to process
  if (items.length > 0) {
    return (
      <div className="p-4 lg:p-6 max-w-2xl">
        <TodoList
          items={items}
          onApprove={approve}
          onSkip={skip}
          onEdit={edit}
          onReschedule={reschedule}
        />
      </div>
    );
  }

  // Distinguish completion vs empty
  if (stats.acted_today > 0) {
    return <CompletionState stats={stats} />;
  }

  return <EmptyState />;
}
