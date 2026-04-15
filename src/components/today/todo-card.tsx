'use client';

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

export function TodoCard(props: TodoCardProps) {
  if (props.item.cardFormat === 'post') {
    return <PostCard {...props} />;
  }
  return <ReplyCard {...props} />;
}
