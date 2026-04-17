'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { TodayActionError, useToday } from '@/hooks/use-today';
import { useToast } from '@/components/ui/toast';
import { TodoList } from '@/components/today/todo-list';
import { CompletionState } from '@/components/today/completion-state';
import { EmptyState } from '@/components/today/empty-state';
import { FirstRun } from '@/components/today/first-run';

interface TodayContentProps {
  isFirstRun: boolean;
}

function platformLabel(platform: string | undefined): string {
  if (!platform) return 'an account';
  if (platform === 'x') return 'X';
  if (platform === 'reddit') return 'Reddit';
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

export function TodayContent({ isFirstRun }: TodayContentProps) {
  const {
    items,
    stats,
    isLoading,
    approve: rawApprove,
    skip: rawSkip,
    edit: rawEdit,
    reschedule: rawReschedule,
    mutate,
  } = useToday();
  const { toast, toastWithAction } = useToast();
  const router = useRouter();
  const [showFirstRun, setShowFirstRun] = useState(isFirstRun);

  const handleItemsReady = useCallback(() => {
    setShowFirstRun(false);
    mutate();
  }, [mutate]);

  const surfaceError = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof TodayActionError && err.code === 'NO_CHANNEL') {
        // Give the user a one-click path to fix the underlying issue.
        toastWithAction({
          message: `Connect ${platformLabel(err.platform)} to publish this post.`,
          variant: 'warning',
          action: {
            label: 'Go to Settings',
            onClick: () => router.push('/settings'),
          },
          timeoutMs: 8_000,
        });
        return;
      }
      const message =
        err instanceof Error && err.message ? err.message : fallback;
      toast(message, 'error');
    },
    [router, toast, toastWithAction],
  );

  const approve = useCallback(
    async (id: string) => {
      try {
        await rawApprove(id);
      } catch (err) {
        surfaceError(err, 'Failed to approve');
      }
    },
    [rawApprove, surfaceError],
  );

  const skip = useCallback(
    async (id: string) => {
      try {
        await rawSkip(id);
      } catch (err) {
        surfaceError(err, 'Failed to skip');
      }
    },
    [rawSkip, surfaceError],
  );

  const edit = useCallback(
    async (id: string, body: string) => {
      try {
        await rawEdit(id, body);
      } catch (err) {
        surfaceError(err, 'Failed to save edit');
      }
    },
    [rawEdit, surfaceError],
  );

  const reschedule = useCallback(
    async (id: string, scheduledFor: string) => {
      try {
        await rawReschedule(id, scheduledFor);
      } catch (err) {
        surfaceError(err, 'Failed to reschedule');
      }
    },
    [rawReschedule, surfaceError],
  );

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
