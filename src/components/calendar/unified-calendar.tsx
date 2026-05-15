'use client';

import { useState } from 'react';
import { useCalendar, type CalendarItem, type CalendarDay } from '@/hooks/use-calendar';
import { useAnalyticsSummary } from '@/hooks/use-analytics-summary';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

const kindLabel: Record<string, string> = {
  content_post: 'Post',
  content_reply: 'Reply',
  email_send: 'Email',
  interview: 'Interview',
  setup_task: 'Task',
  launch_asset: 'Asset',
  runsheet_beat: 'Beat',
  metrics_compute: 'Metrics',
  analytics_summary: 'Analytics',
};

const stateVariant: Record<string, 'default' | 'success' | 'warning' | 'accent'> = {
  planned: 'default',
  drafting: 'warning',
  drafted: 'warning',
  ready_for_review: 'accent',
  approved: 'accent',
  executing: 'accent',
  completed: 'success',
  skipped: 'default',
  failed: 'default',
  superseded: 'default',
  stale: 'default',
};

function formatWeekRange(weekStart: string | undefined, weekEnd: string | undefined): string {
  if (!weekStart || !weekEnd) return '';
  const start = new Date(weekStart);
  const end = new Date(weekEnd);
  end.setUTCDate(end.getUTCDate() - 1); // inclusive last day
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString('en-US', opts)} – ${end.toLocaleDateString('en-US', opts)}`;
}

function formatDayHeader(dateStr: string): { weekday: string; date: string } {
  const d = new Date(dateStr + 'T00:00:00Z');
  return {
    weekday: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
    date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  };
}

export function UnifiedCalendar() {
  const [weekStart, setWeekStart] = useState<string | undefined>(undefined);
  const { days, totals, prev, next, weekStart: ws, weekEnd: we, isLoading } = useCalendar(weekStart);
  const { summary } = useAnalyticsSummary();

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

  return (
    <div className="flex-1 p-6">
      {/* Week navigation */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => setWeekStart(prev ? new Date(prev).toISOString().slice(0, 10) : undefined)}
          disabled={!prev}
          className="text-[14px] tracking-[-0.224px] text-sf-text-secondary hover:text-sf-text-primary disabled:opacity-40 transition-colors"
        >
          ← Prev
        </button>
        <div className="text-center">
          <p className="text-[15px] tracking-[-0.3px] font-medium text-sf-text-primary">
            {formatWeekRange(ws, we)}
          </p>
          <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary">
            {totals.scheduled} scheduled · {totals.completed} completed · {totals.skipped} skipped
          </p>
        </div>
        <button
          onClick={() => setWeekStart(next ? new Date(next).toISOString().slice(0, 10) : undefined)}
          disabled={!next}
          className="text-[14px] tracking-[-0.224px] text-sf-text-secondary hover:text-sf-text-primary disabled:opacity-40 transition-colors"
        >
          Next →
        </button>
      </div>

      {/* Analytics insights panel */}
      {summary && (
        <div className="rounded-[var(--radius-sf-lg)] p-4 mb-6 bg-sf-bg-secondary shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)]">
          <h4 className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-tertiary uppercase mb-3">
            Performance Insights (30d)
          </h4>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mb-1.5">Best content types</p>
              <div className="flex flex-col gap-1">
                {(summary.bestContentTypes as Array<{ type: string; avgBookmarks: number }>)
                  .slice(0, 3)
                  .map((ct) => (
                    <div key={ct.type} className="flex items-center gap-2">
                      <Badge variant="default">{ct.type}</Badge>
                      <span className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary">
                        {ct.avgBookmarks.toFixed(1)} avg bookmarks
                      </span>
                    </div>
                  ))}
              </div>
            </div>
            <div>
              <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mb-1.5">Optimal posting hours</p>
              <div className="flex flex-wrap gap-1">
                {(summary.bestPostingHours as Array<{ hour: number; avgEngagement: number }>)
                  .slice(0, 4)
                  .map((ph) => (
                    <span
                      key={ph.hour}
                      className="text-[12px] tracking-[-0.12px] font-mono text-sf-accent bg-sf-accent/10 px-1.5 py-0.5 rounded"
                    >
                      {String(ph.hour).padStart(2, '0')}:00
                    </span>
                  ))}
              </div>
            </div>
            <div>
              <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mb-1.5">Key metrics</p>
              <div className="flex flex-col gap-0.5 text-[12px] tracking-[-0.12px]">
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

      {/* 7-day todo list */}
      <div className="flex flex-col gap-4">
        {days.map((day) => (
          <DayColumn key={day.date} day={day} />
        ))}
      </div>
    </div>
  );
}

function DayColumn({ day }: { day: CalendarDay }) {
  const { weekday, date } = formatDayHeader(day.date);
  const isEmpty = day.items.length === 0;

  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-[13px] tracking-[-0.2px] font-semibold text-sf-text-primary">{weekday}</span>
        <span className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary">{date}</span>
        {!isEmpty && (
          <span className="text-[11px] tracking-[-0.1px] text-sf-text-tertiary ml-auto">
            {day.items.filter((i) => i.state === 'completed').length}/{day.items.length} done
          </span>
        )}
      </div>
      {isEmpty ? (
        <div className="py-3 px-4 rounded-[var(--radius-sf-md)] border border-dashed border-sf-border text-[12px] tracking-[-0.12px] text-sf-text-tertiary">
          No items
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {day.items.map((item) => (
            <CalendarItemRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function CalendarItemRow({ item }: { item: CalendarItem }) {
  const isCompleted = item.state === 'completed';
  const isSkipped = item.state === 'skipped';

  return (
    <Card
      className="flex items-center gap-3 py-2.5 px-3"
      data-slot-state={item.state}
    >
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{
          background: isCompleted
            ? 'var(--color-sf-success)'
            : isSkipped
            ? 'var(--color-sf-text-tertiary)'
            : 'var(--color-sf-accent)',
        }}
        aria-hidden
      />
      <span className="flex-1 min-w-0">
        <span
          className={`text-[14px] tracking-[-0.224px] truncate block ${
            isCompleted || isSkipped ? 'text-sf-text-tertiary line-through' : 'text-sf-text-primary'
          }`}
        >
          {item.title}
        </span>
      </span>
      <div className="flex items-center gap-2 flex-shrink-0">
        {item.channel && (
          <span className="text-[11px] tracking-[-0.1px] text-sf-text-tertiary font-mono">
            {item.channel}
          </span>
        )}
        <Badge variant={stateVariant[item.state] ?? 'default'}>
          {kindLabel[item.kind] ?? item.kind}
        </Badge>
      </div>
    </Card>
  );
}
