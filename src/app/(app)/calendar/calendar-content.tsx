'use client';

/**
 * /calendar — 7-day day-stacked todo list against `plan_items`.
 * Reads `/api/calendar?weekStart=` and renders one section per day.
 * Navigate week-by-week with Prev / Next buttons.
 */

import { useState } from 'react';
import useSWR from 'swr';
import { HeaderBar } from '@/components/layout/header-bar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import type { CalendarResponse, CalendarDay, CalendarItem } from '@/hooks/use-calendar';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

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

const stateColors: Record<string, string> = {
  planned: 'var(--color-sf-text-tertiary)',
  drafting: 'var(--color-sf-warning)',
  drafted: 'var(--color-sf-warning)',
  ready_for_review: 'var(--color-sf-accent)',
  approved: 'var(--color-sf-accent)',
  executing: 'var(--color-sf-accent)',
  completed: 'var(--color-sf-success)',
  skipped: 'var(--color-sf-text-tertiary)',
  failed: 'var(--color-sf-error)',
  superseded: 'var(--color-sf-text-tertiary)',
  stale: 'var(--color-sf-text-tertiary)',
};

function isToday(dateStr: string): boolean {
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local
  return dateStr === today;
}

function formatDayHeader(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatWeekRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  e.setUTCDate(e.getUTCDate() - 1);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return `${s.toLocaleDateString('en-US', opts)} – ${e.toLocaleDateString('en-US', opts)}`;
}

export function CalendarContent() {
  const [weekStart, setWeekStart] = useState<string | undefined>(undefined);
  const key = weekStart
    ? `/api/calendar?weekStart=${encodeURIComponent(weekStart)}`
    : '/api/calendar';

  const { data, isLoading } = useSWR<CalendarResponse>(key, fetcher, {
    refreshInterval: 60_000,
  });

  const days = data?.days ?? [];
  const totals = data?.totals ?? { scheduled: 0, completed: 0, skipped: 0 };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: 'var(--sf-bg-primary)',
      }}
    >
      <HeaderBar title="Calendar" />

      <main
        style={{
          flex: 1,
          maxWidth: 720,
          width: '100%',
          margin: '0 auto',
          padding: '24px 16px 48px',
        }}
      >
        {/* Week navigation */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 24,
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setWeekStart(
                data?.prev
                  ? new Date(data.prev).toISOString().slice(0, 10)
                  : undefined,
              )
            }
            disabled={!data?.prev}
          >
            ← Prev
          </Button>

          <div style={{ textAlign: 'center' }}>
            {data && (
              <>
                <p
                  style={{
                    fontSize: 15,
                    letterSpacing: '-0.3px',
                    fontWeight: 600,
                    color: 'var(--sf-fg-1)',
                  }}
                >
                  {formatWeekRange(data.weekStart, data.weekEnd)}
                </p>
                <p
                  style={{
                    fontSize: 12,
                    letterSpacing: '-0.12px',
                    color: 'var(--sf-fg-3)',
                    marginTop: 2,
                  }}
                >
                  {totals.scheduled} scheduled · {totals.completed} completed
                  {totals.skipped > 0 ? ` · ${totals.skipped} skipped` : ''}
                </p>
              </>
            )}
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setWeekStart(
                data?.next
                  ? new Date(data.next).toISOString().slice(0, 10)
                  : undefined,
              )
            }
            disabled={!data?.next}
          >
            Next →
          </Button>
        </div>

        {isLoading ? (
          <SkeletonWeek />
        ) : days.every((d) => d.items.length === 0) ? (
          <EmptyState
            title="Nothing scheduled this week"
            hint="Plan items added by the team will appear here."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
            {days.map((day) => (
              <DaySection key={day.date} day={day} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function DaySection({ day }: { day: CalendarDay }) {
  const today = isToday(day.date);
  const isEmpty = day.items.length === 0;
  const doneCount = day.items.filter((i) => i.state === 'completed').length;

  return (
    <section>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <h2
          style={{
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: '-0.2px',
            color: today ? 'var(--sf-accent)' : 'var(--sf-fg-1)',
          }}
        >
          {formatDayHeader(day.date)}
          {today && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--sf-accent)',
                background: 'var(--sf-accent-subtle)',
                borderRadius: 4,
                padding: '1px 6px',
              }}
            >
              Today
            </span>
          )}
        </h2>
        {!isEmpty && (
          <span style={{ fontSize: 11, color: 'var(--sf-fg-3)', marginLeft: 'auto' }}>
            {doneCount}/{day.items.length}
          </span>
        )}
      </div>

      {isEmpty ? (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: 8,
            border: '1px dashed var(--sf-border)',
            fontSize: 12,
            color: 'var(--sf-fg-3)',
          }}
        >
          No items
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {day.items.map((item) => (
            <PlanItemRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

function PlanItemRow({ item }: { item: CalendarItem }) {
  const isCompleted = item.state === 'completed';
  const isSkipped = item.state === 'skipped';
  const dotColor = stateColors[item.state] ?? 'var(--color-sf-text-tertiary)';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderRadius: 8,
        background: 'var(--sf-bg-secondary)',
        border: '1px solid var(--sf-border)',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: dotColor,
          flexShrink: 0,
        }}
        aria-hidden
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 14,
          letterSpacing: '-0.224px',
          color: isCompleted || isSkipped ? 'var(--sf-fg-3)' : 'var(--sf-fg-1)',
          textDecoration: isCompleted ? 'line-through' : undefined,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {item.title}
      </span>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}
      >
        {item.channel && (
          <span
            style={{
              fontSize: 11,
              letterSpacing: '-0.1px',
              color: 'var(--sf-fg-3)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {item.channel}
          </span>
        )}
        <span
          style={{
            fontSize: 11,
            letterSpacing: '-0.1px',
            color: 'var(--sf-fg-3)',
            background: 'var(--sf-bg-tertiary)',
            borderRadius: 4,
            padding: '2px 6px',
          }}
        >
          {kindLabel[item.kind] ?? item.kind}
        </span>
      </div>
    </div>
  );
}

function SkeletonWeek() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i}>
          <div
            style={{
              height: 14,
              width: 120,
              borderRadius: 4,
              background: 'var(--sf-bg-tertiary)',
              marginBottom: 8,
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Array.from({ length: 2 }).map((_, j) => (
              <div
                key={j}
                style={{
                  height: 40,
                  borderRadius: 8,
                  background: 'var(--sf-bg-secondary)',
                }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
