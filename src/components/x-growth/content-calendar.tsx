'use client';

import { useState, useCallback } from 'react';
import { useCalendar } from '@/hooks/use-calendar';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

const typeColors: Record<string, 'accent' | 'success' | 'warning' | 'error' | 'default'> = {
  metric: 'accent',
  educational: 'success',
  engagement: 'warning',
  product: 'error',
  thread: 'default',
};

const statusVariant: Record<string, 'default' | 'success' | 'warning' | 'accent'> = {
  scheduled: 'default',
  draft_created: 'warning',
  approved: 'accent',
  posted: 'success',
  skipped: 'default',
};

export function ContentCalendar() {
  const { items, isLoading, generateWeek, cancelItem } = useCalendar('14d');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      await generateWeek();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
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

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  // Group by day
  const byDay = new Map<string, typeof items>();
  for (const item of items) {
    const day = new Date(item.scheduledAt).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const arr = byDay.get(day) ?? [];
    arr.push(item);
    byDay.set(day, arr);
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[13px] font-medium text-sf-text-secondary uppercase tracking-wider">
            Content Calendar
          </h3>
          <p className="text-[12px] text-sf-text-tertiary mt-0.5">
            {items.filter((i) => i.status === 'scheduled').length} scheduled,{' '}
            {items.filter((i) => i.status === 'posted').length} posted
          </p>
        </div>
        <Button onClick={handleGenerate} disabled={generating}>
          {generating ? 'Generating...' : 'Generate Week'}
        </Button>
      </div>

      {/* Content mix legend */}
      <div className="flex items-center gap-4 text-[11px] text-sf-text-tertiary">
        <span>Content mix:</span>
        {Object.entries(typeColors).map(([type, variant]) => (
          <span key={type} className="flex items-center gap-1">
            <Badge variant={variant}>{type}</Badge>
          </span>
        ))}
      </div>

      {error && (
        <div className="px-4 py-3 rounded-[var(--radius-sf-md)] bg-sf-error-light border border-sf-error/20 text-[13px] text-sf-error">
          {error}
        </div>
      )}

      {items.length === 0 ? (
        <div className="flex flex-col items-center py-16">
          <div className="w-14 h-14 mb-4 rounded-full bg-sf-bg-secondary border border-sf-border flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-sf-text-tertiary)" strokeWidth="1.5">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
          </div>
          <p className="text-[14px] font-medium text-sf-text-primary mb-1">
            No scheduled posts
          </p>
          <p className="text-[13px] text-sf-text-tertiary max-w-[300px] text-center">
            Click <span className="font-medium text-sf-text-secondary">Generate Week</span> to
            auto-create a week of content with the optimal 40/30/20/10 content mix.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {Array.from(byDay.entries()).map(([day, dayItems]) => (
            <div key={day}>
              <h4 className="text-[12px] font-medium text-sf-text-secondary mb-2">{day}</h4>
              <div className="flex flex-col gap-1.5">
                {dayItems.map((item) => (
                  <Card key={item.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-[12px] font-mono text-sf-text-tertiary tabular-nums w-14 flex-shrink-0">
                        {new Date(item.scheduledAt).toLocaleTimeString('en-US', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <Badge variant={typeColors[item.contentType] ?? 'default'}>
                        {item.contentType}
                      </Badge>
                      {item.topic && (
                        <span className="text-[13px] text-sf-text-secondary truncate">
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
                          onClick={() => handleCancel(item.id)}
                          className="text-sf-text-tertiary hover:text-sf-error transition-colors p-1"
                          title="Cancel"
                        >
                          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M3 3l8 8M11 3l-8 8" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
