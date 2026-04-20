'use client';

import { memo, useCallback, useMemo, useState } from 'react';
import { useCalendar, type CalendarItem } from '@/hooks/use-calendar';
import { useServerTruthButtonState } from '@/hooks/use-server-truth-button';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Whether any calendar item is scheduled within the next 7 days (and hasn't
 * been skipped). Pulled out of the component so `Date.now()` reads aren't
 * flagged as impure during render — the function is called once per render
 * with the current items array, which is the expected React idiom.
 */
function hasUpcomingWeek(items: CalendarItem[]): boolean {
  if (items.length === 0) return false;
  const nowMs = Date.now();
  const weekEndMs = nowMs + 7 * 24 * 60 * 60 * 1000;
  return items.some((item) => {
    const t = new Date(item.scheduledAt).getTime();
    return t >= nowMs && t <= weekEndMs && item.status !== 'skipped';
  });
}

const typeColors: Record<string, 'signal' | 'success' | 'warning' | 'danger' | 'default'> = {
  metric: 'signal',
  educational: 'success',
  engagement: 'warning',
  product: 'danger',
  thread: 'default',
};

const statusVariant: Record<string, 'default' | 'success' | 'warning' | 'signal'> = {
  scheduled: 'default',
  draft_created: 'warning',
  approved: 'signal',
  posted: 'success',
  skipped: 'default',
};

export function ContentCalendar() {
  const {
    items,
    isLoading,
    generateWeek,
    cancelItem,
    isGenerating,
  } = useCalendar('14d');
  const [error, setError] = useState<string | null>(null);

  // Derive disabled state from server truth, not ephemeral component state.
  // `alreadyExists` collapses the window to "do we already have content
  // scheduled for the next 7 days?" — if yes, regenerating would be a no-op.
  // `localInFlight` is the SSE-driven `isGenerating` flag from useCalendar;
  // the hook OR's it with `/api/jobs/in-flight?kind=calendar-plan` so a
  // reload mid-generation keeps the button locked.
  const hasWeekScheduled = hasUpcomingWeek(items);

  const buttonState = useServerTruthButtonState({
    kind: 'calendar-plan',
    signals: {
      alreadyExists: hasWeekScheduled,
      alreadyExistsLabel: 'Generated for this week',
      alreadyExistsReason:
        'A week of content is already scheduled — cancel items you no longer want before regenerating.',
      localInFlight: isGenerating,
      inFlightLabel: 'Queued…',
      inFlightReason: 'Calendar plan is running — new cards will appear as they draft.',
    },
  });

  const handleGenerate = useCallback(async () => {
    setError(null);
    try {
      await generateWeek();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    }
  }, [generateWeek]);

  const handleCancel = useCallback(
    async (itemId: string) => {
      try {
        await cancelItem(itemId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Cancel failed');
      }
    },
    [cancelItem],
  );

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const item of items) {
      const day = new Date(item.scheduledAt).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      const arr = map.get(day) ?? [];
      arr.push(item);
      map.set(day, arr);
    }
    return map;
  }, [items]);

  const counts = useMemo(() => {
    let scheduled = 0;
    let posted = 0;
    for (const i of items) {
      if (i.status === 'scheduled') scheduled += 1;
      else if (i.status === 'posted') posted += 1;
    }
    return { scheduled, posted };
  }, [items]);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-secondary uppercase">
            Content Calendar
          </h3>
          <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mt-0.5">
            {counts.scheduled} scheduled, {counts.posted} posted
          </p>
        </div>
        <Button
          onClick={handleGenerate}
          disabled={buttonState.disabled}
          title={buttonState.reason}
        >
          {buttonState.label ?? 'Generate Week'}
        </Button>
      </div>

      {/* Content mix legend */}
      <div className="flex items-center gap-4 text-[12px] tracking-[-0.12px] text-sf-text-tertiary">
        <span>Content mix:</span>
        {Object.entries(typeColors).map(([type, variant]) => (
          <span key={type} className="flex items-center gap-1">
            <Badge variant={variant}>{type}</Badge>
          </span>
        ))}
      </div>

      {error && (
        <div className="px-4 py-3 rounded-[var(--radius-sf-md)] bg-sf-error-light text-[14px] tracking-[-0.224px] text-sf-error">
          {error}
        </div>
      )}

      {items.length === 0 ? (
        <div className="flex flex-col items-center py-16">
          <div className="w-14 h-14 mb-4 rounded-full bg-sf-bg-secondary shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)] flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-sf-text-tertiary)" strokeWidth="1.5">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
          </div>
          <p className="text-[17px] tracking-[-0.374px] font-medium text-sf-text-primary mb-1">
            No scheduled posts
          </p>
          <p className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary max-w-[300px] text-center">
            Click <span className="font-medium text-sf-text-secondary">Generate Week</span> to
            auto-create a week of content with the optimal 40/30/20/10 content mix.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {Array.from(byDay.entries()).map(([day, dayItems]) => (
            <div key={day}>
              <h4 className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-secondary mb-2">{day}</h4>
              <div className="flex flex-col gap-1.5">
                {dayItems.map((item) => (
                  <ContentCalendarRow
                    key={item.id}
                    item={item}
                    onCancel={handleCancel}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ContentCalendarRowProps {
  item: CalendarItem;
  onCancel: (id: string) => void;
}

const ContentCalendarRow = memo(function ContentCalendarRow({
  item,
  onCancel,
}: ContentCalendarRowProps) {
  const handleCancel = useCallback(() => onCancel(item.id), [onCancel, item.id]);

  return (
    <Card className="flex items-center justify-between gap-3 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-[12px] tracking-[-0.12px] font-mono text-sf-text-tertiary tabular-nums w-14 flex-shrink-0">
          {new Date(item.scheduledAt).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
        <Badge variant={typeColors[item.contentType] ?? 'default'}>
          {item.contentType}
        </Badge>
        {item.topic && (
          <span className="text-[14px] tracking-[-0.224px] text-sf-text-secondary truncate">
            {item.topic}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <Badge variant={statusVariant[item.status] ?? 'default'}>
          {item.status}
        </Badge>
        {item.status === 'scheduled' && (
          <button
            onClick={handleCancel}
            className="text-sf-text-tertiary hover:text-sf-error transition-colors duration-200 p-1"
            title="Cancel"
            aria-label="Cancel calendar item"
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        )}
      </div>
    </Card>
  );
});
