'use client';

import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { SWRConfig } from 'swr';
import { TodayActionError, useToday } from '@/hooks/use-today';
import type { TodayStats } from '@/hooks/use-today';
import { useToast } from '@/components/ui/toast';
import { TodoList } from '@/components/today/todo-list';
import { CompletionState } from '@/components/today/completion-state';
import type { YesterdayTop } from '@/components/today/completion-state';
import { EmptyState } from '@/components/today/empty-state';
import { FirstRun } from '@/components/today/first-run';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { ShortcutsHelp, type ShortcutBinding } from '@/components/ui/shortcuts-help';

interface RawTodoItemPayload {
  id: string;
  // The full payload is structurally validated on the client by useToday's
  // derivation — we only need a loose shape here because this value is
  // round-tripped through SWR cache as-is.
  [key: string]: unknown;
}

interface TodayFallbackData {
  items: RawTodoItemPayload[];
  stats: TodayStats;
}

interface TodayContentProps {
  isFirstRun: boolean;
  hasChannel: boolean;
  fallbackData: TodayFallbackData;
  yesterdayTop: YesterdayTop | null;
}

function platformLabel(platform: string | undefined): string {
  if (!platform) return 'an account';
  if (platform === 'x') return 'X';
  if (platform === 'reddit') return 'Reddit';
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

export function TodayContent({
  isFirstRun,
  hasChannel,
  fallbackData,
  yesterdayTop,
}: TodayContentProps) {
  return (
    // Seed SWR's cache with the server-rendered payload so the first render
    // skips the client fetch + loading flash. `useToday()` (and any other
    // consumer keyed on '/api/today') picks this up transparently.
    <SWRConfig value={{ fallback: { '/api/today': fallbackData } }}>
      <TodayContentInner
        isFirstRun={isFirstRun}
        hasChannel={hasChannel}
        yesterdayTop={yesterdayTop}
      />
    </SWRConfig>
  );
}

interface TodayContentInnerProps {
  isFirstRun: boolean;
  hasChannel: boolean;
  yesterdayTop: YesterdayTop | null;
}

function TodayContentInner({
  isFirstRun,
  hasChannel,
  yesterdayTop,
}: TodayContentInnerProps) {
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
  const [activeIndex, setActiveIndex] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const handleItemsReady = useCallback(() => {
    setShowFirstRun(false);
    mutate();
  }, [mutate]);

  const surfaceError = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof TodayActionError && err.code === 'NO_CHANNEL') {
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

  const shortcutBindings: ShortcutBinding[] = useMemo(
    () => [
      { keys: 'j', label: 'Next item' },
      { keys: 'k', label: 'Previous item' },
      { keys: 'a', label: 'Approve current item' },
      { keys: 'e', label: 'Edit current item' },
      { keys: 's', label: 'Skip current item' },
      { keys: '?', label: 'Show this help' },
    ],
    [],
  );

  useKeyboardShortcuts(
    {
      j: () =>
        setActiveIndex((i) => Math.min(i + 1, Math.max(items.length - 1, 0))),
      k: () => setActiveIndex((i) => Math.max(i - 1, 0)),
      a: () => {
        const target = items[activeIndex];
        if (target) void approve(target.id);
      },
      e: () => {
        const target = items[activeIndex];
        if (target) setEditingId(target.id);
      },
      s: () => {
        const target = items[activeIndex];
        if (target) void skip(target.id);
      },
      '?': () => setHelpOpen(true),
    },
    [items, activeIndex, approve, skip],
  );

  // First-run experience
  if (showFirstRun && items.length === 0) {
    return <FirstRun onItemsReady={handleItemsReady} hasChannel={hasChannel} />;
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
          activeId={items[activeIndex]?.id ?? null}
          editingId={editingId}
          onEditDone={() => setEditingId(null)}
        />
        <ShortcutsHelp
          open={helpOpen}
          onClose={() => setHelpOpen(false)}
          bindings={shortcutBindings}
        />
      </div>
    );
  }

  // Distinguish completion vs empty
  if (stats.acted_today > 0) {
    return <CompletionState stats={stats} yesterdayTop={yesterdayTop} />;
  }

  return <EmptyState />;
}
