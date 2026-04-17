'use client';

import { memo } from 'react';
import { PostCard } from './post-card';
import { ReplyCard } from './reply-card';
import type { TodoItem } from '@/hooks/use-today';

export interface TodoCardProps {
  item: TodoItem;
  onApprove: (id: string) => void;
  onSkip: (id: string) => void;
  onEdit: (id: string, body: string) => void;
  onReschedule?: (id: string, scheduledFor: string) => void;
}

// Memoized so the list doesn't re-render every card on unrelated parent
// state changes (FirstRun toggles, stats refresh, etc). Callbacks coming from
// use-today.ts are already stable via useCallback.
export const TodoCard = memo(function TodoCard(props: TodoCardProps) {
  if (props.item.cardFormat === 'post') {
    return <PostCard {...props} />;
  }
  return <ReplyCard {...props} />;
});
