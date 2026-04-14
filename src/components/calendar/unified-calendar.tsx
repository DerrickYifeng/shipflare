'use client';

import { useState, useCallback } from 'react';
import { useCalendar, type CalendarItem } from '@/hooks/use-calendar';
import { useAnalyticsSummary } from '@/hooks/use-analytics-summary';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

const channels = [
  { id: 'all', label: 'All Channels' },
  { id: 'x', label: 'X', icon: XChannelIcon },
];

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

export function UnifiedCalendar() {
  const [activeChannel, setActiveChannel] = useState('all');
  const { items, isLoading, generateWeek, cancelItem } = useCalendar('14d', activeChannel);
  const { summary } = useAnalyticsSummary();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      // When filtered to a specific channel, generate for that channel.
      // When "all", default to 'x' (only channel available now).
      const channel = activeChannel !== 'all' ? activeChannel : 'x';
      await generateWeek(channel);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }, [generateWeek, activeChannel]);

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
      <div className="flex-1 p-6">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
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
    <div className="flex-1 p-6">
      {/* Channel filter pills */}
      <div className="flex items-center gap-1 mb-6">
        {channels.map((ch) => (
          <button
            key={ch.id}
            onClick={() => setActiveChannel(ch.id)}
            className={`
              flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sf-md)]
              text-[13px] font-medium transition-colors duration-150
              ${activeChannel === ch.id
                ? 'bg-sf-bg-tertiary text-sf-text-primary'
                : 'text-sf-text-secondary hover:bg-sf-bg-secondary hover:text-sf-text-primary'
              }
            `}
          >
            {ch.icon && <ch.icon />}
            {ch.label}
          </button>
        ))}
      </div>

      {/* Analytics insights panel */}
      {summary && (
        <div className="border border-sf-border rounded-[var(--radius-sf-lg)] p-4 mb-6 bg-sf-bg-primary">
          <h4 className="text-[12px] font-medium text-sf-text-tertiary uppercase tracking-wider mb-3">
            Performance Insights (30d)
          </h4>
          <div className="grid grid-cols-3 gap-4">
            {/* Best content types */}
            <div>
              <p className="text-[11px] text-sf-text-tertiary mb-1.5">Best content types</p>
              <div className="flex flex-col gap-1">
                {(summary.bestContentTypes as Array<{ type: string; avgBookmarks: number }>)
                  .slice(0, 3)
                  .map((ct) => (
                    <div key={ct.type} className="flex items-center gap-2">
                      <Badge variant={typeColors[ct.type] ?? 'default'}>{ct.type}</Badge>
                      <span className="text-[11px] text-sf-text-tertiary">
                        {ct.avgBookmarks.toFixed(1)} avg bookmarks
                      </span>
                    </div>
                  ))}
              </div>
            </div>
            {/* Optimal hours */}
            <div>
              <p className="text-[11px] text-sf-text-tertiary mb-1.5">Optimal posting hours</p>
              <div className="flex flex-wrap gap-1">
                {(summary.bestPostingHours as Array<{ hour: number; avgEngagement: number }>)
                  .slice(0, 4)
                  .map((ph) => (
                    <span
                      key={ph.hour}
                      className="text-[12px] font-mono text-sf-accent bg-sf-accent/10 px-1.5 py-0.5 rounded"
                    >
                      {String(ph.hour).padStart(2, '0')}:00
                    </span>
                  ))}
              </div>
            </div>
            {/* Key metrics */}
            <div>
              <p className="text-[11px] text-sf-text-tertiary mb-1.5">Key metrics</p>
              <div className="flex flex-col gap-0.5 text-[12px]">
                <span className="text-sf-text-secondary">
                  {(summary.engagementRate * 100).toFixed(2)}% engagement rate
                </span>
                <span className="text-sf-text-secondary">
                  +{summary.audienceGrowthRate.toFixed(1)}/day growth
                </span>
                <span className="text-sf-text-tertiary">
                  {summary.totalImpressions.toLocaleString()} impressions
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-[12px] text-sf-text-tertiary">
            {items.filter((i) => i.status === 'scheduled').length} scheduled,{' '}
            {items.filter((i) => i.status === 'posted').length} posted
          </p>
        </div>
        <Button onClick={handleGenerate} disabled={generating} variant="secondary">
          {generating ? 'Generating...' : 'Generate Week'}
        </Button>
      </div>

      {/* Content mix legend */}
      <div className="flex items-center gap-4 text-[11px] text-sf-text-tertiary mb-6">
        <span>Content mix:</span>
        {Object.entries(typeColors).map(([type, variant]) => (
          <span key={type} className="flex items-center gap-1">
            <Badge variant={variant}>{type}</Badge>
          </span>
        ))}
      </div>

      {error && (
        <div className="px-4 py-3 rounded-[var(--radius-sf-md)] bg-sf-error-light border border-sf-error/20 text-[13px] text-sf-error mb-4">
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
            auto-create a week of content with the optimal content mix.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {Array.from(byDay.entries()).map(([day, dayItems]) => (
            <div key={day}>
              <h4 className="text-[12px] font-medium text-sf-text-secondary mb-2">{day}</h4>
              <div className="flex flex-col gap-1.5">
                {dayItems.map((item) => (
                  <CalendarItemCard
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

function CalendarItemCard({
  item,
  onCancel,
}: {
  item: CalendarItem;
  onCancel: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="flex flex-col py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <ChannelIcon channel={item.channel} />
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
          {item.draftPreview && (
            <button
              type="button"
              onClick={() => setExpanded((p) => !p)}
              className="text-[11px] text-sf-accent hover:underline"
            >
              {expanded ? 'Hide' : 'Preview'}
            </button>
          )}
          <Badge variant={statusVariant[item.status] ?? 'default'}>
            {item.status}
          </Badge>
          <button
            onClick={() => onCancel(item.id)}
            className="text-sf-text-tertiary hover:text-sf-error transition-colors p-1"
            title="Delete"
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        </div>
      </div>
      {expanded && item.draftPreview && (
        <div className="mt-2 pt-2 border-t border-sf-border animate-sf-fade-in">
          <p className="text-[12px] text-sf-text-secondary leading-relaxed line-clamp-4">
            {item.draftPreview}
          </p>
        </div>
      )}
    </Card>
  );
}

function ChannelIcon({ channel }: { channel: string }) {
  if (channel === 'x') return <XChannelIcon />;
  return (
    <span className="w-[14px] h-[14px] rounded-full bg-sf-bg-tertiary flex items-center justify-center text-[8px] font-medium text-sf-text-tertiary uppercase flex-shrink-0">
      {channel[0]}
    </span>
  );
}

function XChannelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-sf-text-secondary flex-shrink-0">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231z" />
    </svg>
  );
}
