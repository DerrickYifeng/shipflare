'use client';

/**
 * Calendar — v2 week view.
 *
 * Pixel reference: handoff pages.jsx `CalendarView`. Real items come from
 * `useCalendar()`; layout converts scheduledAt → day-of-week + fractional hour
 * inside the user's local timezone. formatHour honors a 12h/24h preference
 * surfaced via /api/preferences.
 */

import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { HeaderBar } from '@/components/layout/header-bar';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ops } from '@/components/ui/ops';
import { PlatformTag } from '@/components/ui/platform-tag';
import { useCalendar, type CalendarItem } from '@/hooks/use-calendar';
import { formatHour } from '@/lib/format-hour';

type KindFilter = 'all' | 'reply' | 'post';

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const ROW_H = 52;
const TOP_PAD = 44;
const GRID_HEIGHT = TOP_PAD + ROW_H * HOURS.length;

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed');
  return res.json();
};

export function CalendarContent() {
  const today = useMemo(() => new Date(), []);
  const [weekStart, setWeekStart] = useState<Date>(() => mondayOf(today));
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [selected, setSelected] = useState<string | null>(null);

  const weekDates = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const { items, isLoading, cancelItem } = useCalendar('30d', 'all');

  const { data: prefs } = useSWR<{
    preferences: { timezone: string };
  }>('/api/preferences', fetcher, { revalidateOnFocus: false });
  // User preference is a timezone (IANA) but for 12h/24h we don't have a
  // dedicated toggle — default to 12h unless the timezone hints 24h (e.g. DE).
  const clock: '12h' | '24h' =
    prefs?.preferences.timezone?.startsWith('Europe/') ? '24h' : '12h';

  const weekLabel = useMemo(() => {
    const a = weekDates[0]!;
    const b = weekDates[6]!;
    if (a.getMonth() === b.getMonth()) {
      return `${MONTHS[a.getMonth()]} ${a.getDate()} – ${b.getDate()}`;
    }
    return `${MONTHS[a.getMonth()]} ${a.getDate()} – ${MONTHS[b.getMonth()]} ${b.getDate()}`;
  }, [weekDates]);

  const isCurrentWeek = sameDay(weekStart, mondayOf(today));
  const prevWeek = () => setWeekStart((w) => addDays(w, -7));
  const nextWeek = () => setWeekStart((w) => addDays(w, 7));
  const goToday = () => setWeekStart(mondayOf(today));

  // Keyboard nav: arrows move weeks, T jumps to today.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? '';
      if (/INPUT|TEXTAREA/.test(tag)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') prevWeek();
      if (e.key === 'ArrowRight') nextWeek();
      if (e.key === 't' || e.key === 'T') goToday();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  // Map items onto the grid.
  type Slot = {
    id: string;
    date: string;
    hour: number;
    duration: number;
    kind: 'reply' | 'post';
    platform: 'reddit' | 'x' | 'hn';
    title: string;
    sent: boolean;
  };
  const slots: Slot[] = useMemo(() => {
    if (!items) return [];
    return items.map((it) => itemToSlot(it));
  }, [items]);

  const filteredSlots = useMemo(
    () =>
      kindFilter === 'all' ? slots : slots.filter((s) => s.kind === kindFilter),
    [slots, kindFilter],
  );

  const weekDateKeys = useMemo(() => weekDates.map(keyOf), [weekDates]);
  const weekReplyCount = slots.filter(
    (s) => s.kind === 'reply' && weekDateKeys.includes(s.date),
  ).length;
  const weekPostCount = slots.filter(
    (s) => s.kind === 'post' && weekDateKeys.includes(s.date),
  ).length;

  const nextSendLabel = useMemo(() => {
    const upcoming = slots
      .filter((s) => !s.sent)
      .map((s) => ({ s, ts: new Date(`${s.date}T${hourToIso(s.hour)}`).getTime() }))
      .filter((row) => row.ts >= today.getTime())
      .sort((a, b) => a.ts - b.ts);
    if (upcoming.length === 0) return '—';
    return formatHour(upcoming[0]!.s.hour, clock);
  }, [slots, today, clock]);

  return (
    <>
      <HeaderBar
        title="Calendar"
        meta={`Week of ${weekLabel} · All scheduled posts & replies your AI team will send`}
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div
              style={{
                display: 'flex',
                gap: 4,
                background: 'var(--sf-paper-sunken)',
                padding: 3,
                borderRadius: 'var(--sf-radius-md)',
              }}
            >
              {(['all', 'reply', 'post'] as KindFilter[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKindFilter(k)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    border: 'none',
                    background: kindFilter === k ? 'var(--sf-paper)' : 'transparent',
                    color: kindFilter === k ? 'var(--sf-fg-1)' : 'var(--sf-fg-3)',
                    fontWeight: kindFilter === k ? 600 : 500,
                    fontSize: 'var(--sf-text-xs)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    boxShadow: kindFilter === k ? 'var(--sf-shadow-sm)' : 'none',
                    textTransform: 'uppercase',
                    letterSpacing: 'var(--sf-track-mono)',
                  }}
                >
                  {k}
                </button>
              ))}
            </div>
            <Button variant="ghost" size="sm" onClick={goToday} disabled={isCurrentWeek}>
              Today
            </Button>
          </div>
        }
      />

      <div style={{ padding: '0 clamp(16px, 3vw, 32px) 48px' }}>
        {/* Week navigation */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 14,
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'stretch',
              border: '1px solid var(--sf-border)',
              borderRadius: 'var(--sf-radius-md)',
              overflow: 'hidden',
              background: 'var(--sf-paper)',
            }}
          >
            <button
              type="button"
              onClick={prevWeek}
              aria-label="Previous week"
              style={navBtn('right')}
            >
              <Chevron dir="left" />
            </button>
            <button
              type="button"
              onClick={goToday}
              disabled={isCurrentWeek}
              style={{
                padding: '6px 14px',
                border: 'none',
                background: 'transparent',
                cursor: isCurrentWeek ? 'default' : 'pointer',
                fontSize: 'var(--sf-text-sm)',
                fontWeight: 500,
                color: isCurrentWeek ? 'var(--sf-fg-4)' : 'var(--sf-fg-1)',
                fontFamily: 'inherit',
                letterSpacing: 'var(--sf-track-normal)',
              }}
            >
              Today
            </button>
            <button
              type="button"
              onClick={nextWeek}
              aria-label="Next week"
              style={navBtn('left')}
            >
              <Chevron dir="right" />
            </button>
          </div>
          <h2
            style={{
              margin: 0,
              fontSize: 'var(--sf-text-h4)',
              fontWeight: 600,
              color: 'var(--sf-fg-1)',
            }}
          >
            {weekLabel}
            <span
              style={{
                marginLeft: 10,
                fontSize: 'var(--sf-text-sm)',
                fontWeight: 400,
                color: 'var(--sf-fg-3)',
              }}
            >
              {weekDates[0]!.getFullYear()}
            </span>
          </h2>
        </div>

        {/* KPI strip */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 12,
            marginBottom: 16,
          }}
        >
          <KpiCard value={weekReplyCount} label="REPLIES THIS WEEK" />
          <KpiCard value={weekPostCount} label="POSTS THIS WEEK" />
          <KpiCard value={nextSendLabel} label="NEXT SEND" />
          <KpiCard value="43 / 120" label="MONTHLY BUDGET" />
        </div>

        {/* Week grid */}
        <Card padding={0} style={{ overflow: 'hidden' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '56px repeat(7, 1fr)',
              position: 'relative',
              minWidth: 720,
            }}
          >
            <div />
            {weekDates.map((date, i) => {
              const isToday = sameDay(date, today);
              const isWeekend = i >= 5;
              return (
                <div
                  key={i}
                  style={{
                    padding: '14px 12px 10px',
                    borderBottom: '1px solid var(--sf-border-subtle)',
                    borderLeft: '1px solid var(--sf-border-subtle)',
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    background: isToday
                      ? 'var(--sf-signal-tint)'
                      : isWeekend
                        ? 'var(--sf-paper-sunken)'
                        : 'transparent',
                  }}
                >
                  <span
                    className="sf-mono"
                    style={{
                      fontSize: 10,
                      color: isWeekend && !isToday ? 'var(--sf-fg-4)' : 'var(--sf-fg-3)',
                      letterSpacing: 'var(--sf-track-mono)',
                    }}
                  >
                    {DAYS[i]}
                  </span>
                  <span
                    style={{
                      fontSize: 'var(--sf-text-h4)',
                      fontWeight: isToday ? 700 : 500,
                      color: isToday ? 'var(--sf-signal)' : 'var(--sf-fg-1)',
                    }}
                  >
                    {date.getDate()}
                  </span>
                  {isToday && (
                    <Badge variant="signal" mono>
                      TODAY
                    </Badge>
                  )}
                </div>
              );
            })}

            {/* Hour labels */}
            <div style={{ position: 'relative', height: GRID_HEIGHT }}>
              {HOURS.map((h, i) => (
                <div
                  key={h}
                  style={{
                    position: 'absolute',
                    top: TOP_PAD + i * ROW_H - 6,
                    right: 8,
                    width: '100%',
                    fontSize: 10,
                    color: 'var(--sf-fg-3)',
                    textAlign: 'right',
                    fontFamily: 'var(--sf-font-mono)',
                    letterSpacing: 'var(--sf-track-mono)',
                  }}
                >
                  {clock === '24h'
                    ? String(h).padStart(2, '0')
                    : `${h > 12 ? h - 12 : h}${h >= 12 ? 'p' : 'a'}`}
                </div>
              ))}
            </div>

            {/* Day columns */}
            {weekDates.map((date, dayIdx) => {
              const isToday = sameDay(date, today);
              const isWeekend = dayIdx >= 5;
              const dateKey = keyOf(date);
              const nowHour = today.getHours() + today.getMinutes() / 60;
              const daySlots = filteredSlots.filter((s) => s.date === dateKey);
              return (
                <div
                  key={dayIdx}
                  style={{
                    position: 'relative',
                    height: GRID_HEIGHT,
                    borderLeft: '1px solid var(--sf-border-subtle)',
                    background: isToday
                      ? 'var(--sf-signal-tint)'
                      : isWeekend
                        ? 'var(--sf-paper-sunken)'
                        : 'transparent',
                  }}
                >
                  {HOURS.map((_, i) => (
                    <div
                      key={i}
                      style={{
                        position: 'absolute',
                        top: TOP_PAD + i * ROW_H,
                        left: 0,
                        right: 0,
                        height: 1,
                        background: 'var(--sf-border-subtle)',
                        opacity: 0.6,
                      }}
                    />
                  ))}
                  {isToday &&
                    nowHour >= HOURS[0]! &&
                    nowHour <= HOURS[HOURS.length - 1]! + 1 && (
                      <div
                        style={{
                          position: 'absolute',
                          top: TOP_PAD + (nowHour - HOURS[0]!) * ROW_H,
                          left: -2,
                          right: 0,
                          height: 2,
                          background: 'var(--sf-danger)',
                          zIndex: 10,
                        }}
                      >
                        <span
                          style={{
                            position: 'absolute',
                            left: -4,
                            top: -4,
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: 'var(--sf-danger)',
                          }}
                        />
                      </div>
                    )}
                  {daySlots.map((slot, i) => {
                    const top = TOP_PAD + (slot.hour - HOURS[0]!) * ROW_H;
                    const h = slot.duration * ROW_H;
                    const bg = slot.sent
                      ? 'var(--sf-paper-sunken)'
                      : slot.kind === 'reply'
                        ? 'var(--sf-signal-tint)'
                        : 'var(--sf-flare-tint)';
                    const borderColor = slot.sent
                      ? 'var(--sf-border)'
                      : slot.kind === 'reply'
                        ? 'var(--sf-signal)'
                        : 'var(--sf-flare)';
                    const selKey = `${dateKey}-${slot.id}`;
                    const isSel = selected === selKey;
                    return (
                      <button
                        key={`${slot.id}-${i}`}
                        type="button"
                        onClick={() => setSelected(selKey)}
                        style={{
                          position: 'absolute',
                          top: top + 2,
                          left: 4,
                          right: 4,
                          minHeight: h,
                          padding: '6px 8px',
                          background: bg,
                          border: `1px solid ${borderColor}`,
                          borderLeft: `3px solid ${borderColor}`,
                          borderRadius: 6,
                          textAlign: 'left',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          boxShadow: isSel ? 'var(--sf-shadow-md)' : 'none',
                          zIndex: isSel ? 20 : 5,
                          transform: isSel ? 'scale(1.02)' : 'scale(1)',
                          transition: 'transform var(--sf-dur-base) var(--sf-ease-swift), box-shadow var(--sf-dur-base) var(--sf-ease-swift)',
                          opacity: slot.sent ? 0.55 : 1,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            marginBottom: 2,
                          }}
                        >
                          <PlatformTag platform={slot.platform} size={14} />
                          <span
                            className="sf-mono"
                            style={{
                              fontSize: 9,
                              color: 'var(--sf-fg-3)',
                              letterSpacing: 'var(--sf-track-mono)',
                              textTransform: 'uppercase',
                            }}
                          >
                            {formatHour(slot.hour, clock)}
                            {slot.sent ? ' · sent' : ''}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--sf-fg-1)',
                            fontWeight: 500,
                            lineHeight: 1.3,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            textDecoration: slot.sent ? 'line-through' : 'none',
                          }}
                        >
                          {slot.title}
                        </div>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </Card>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            margin: '12px 2px 0',
            fontSize: 'var(--sf-text-xs)',
            color: 'var(--sf-fg-3)',
            flexWrap: 'wrap',
          }}
        >
          <LegendDot kind="reply" />
          <LegendDot kind="post" />
          <span>Tap a card to preview, arrows to navigate weeks, T to return to today.</span>
        </div>

        {/* Empty state fallback */}
        {!isLoading && slots.length === 0 && (
          <div style={{ marginTop: 24 }}>
            <Card padding={28}>
              <div style={{ textAlign: 'center', color: 'var(--sf-fg-3)', fontSize: 'var(--sf-text-sm)' }}>
                Nothing scheduled yet. Generate a week plan to populate the calendar.
              </div>
            </Card>
          </div>
        )}

        {/* Simple selection-drawer affordance to confirm slot cancellation. */}
        {selected && (
          <SlotDrawer
            slotKey={selected}
            items={items ?? []}
            onClose={() => setSelected(null)}
            onCancel={async (id) => {
              try {
                await cancelItem(id);
                setSelected(null);
              } catch {
                // toast already surfaced; keep drawer open
              }
            }}
            clock={clock}
          />
        )}
      </div>
    </>
  );
}

function navBtn(side: 'left' | 'right') {
  return {
    padding: '6px 10px',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    color: 'var(--sf-fg-2)',
    fontFamily: 'inherit',
    [side === 'right' ? 'borderRight' : 'borderLeft']: '1px solid var(--sf-border-subtle)',
    display: 'flex',
    alignItems: 'center',
  } as const;
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d={dir === 'left' ? 'M8.5 3.5L5 7l3.5 3.5' : 'M5.5 3.5L9 7l-3.5 3.5'} />
    </svg>
  );
}

function KpiCard({ value, label }: { value: string | number; label: string }) {
  return (
    <Card padding={14}>
      <div
        className="sf-mono"
        style={{
          fontSize: 'var(--sf-text-h3)',
          fontWeight: 500,
          color: 'var(--sf-fg-1)',
        }}
      >
        {value}
      </div>
      <Ops style={{ display: 'block', marginTop: 4 }}>{label}</Ops>
    </Card>
  );
}

function LegendDot({ kind }: { kind: 'reply' | 'post' }) {
  const color = kind === 'reply' ? 'signal' : 'flare';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          width: 10,
          height: 10,
          background: `var(--sf-${color}-tint)`,
          border: `1px solid var(--sf-${color})`,
          borderLeft: `3px solid var(--sf-${color})`,
          borderRadius: 3,
        }}
      />
      {kind === 'reply' ? 'Reply' : 'Post'}
    </span>
  );
}

function SlotDrawer({
  slotKey,
  items,
  onClose,
  onCancel,
  clock,
}: {
  slotKey: string;
  items: CalendarItem[];
  onClose: () => void;
  onCancel: (id: string) => Promise<void>;
  clock: '12h' | '24h';
}) {
  // slotKey is "YYYY-MM-DD-<itemId>"; extract item id (last segment).
  const parts = slotKey.split('-');
  const id = parts.slice(3).join('-');
  const item = items.find((it) => it.id === id);
  if (!item) return null;
  const when = new Date(item.scheduledAt);
  return (
    <div
      role="dialog"
      aria-labelledby="slot-drawer-title"
      style={{
        position: 'fixed',
        right: 24,
        bottom: 24,
        width: 'min(400px, calc(100vw - 48px))',
        background: 'var(--sf-paper-raised)',
        border: '1px solid var(--sf-border)',
        borderRadius: 'var(--sf-radius-lg)',
        boxShadow: 'var(--sf-shadow-lg)',
        padding: 20,
        zIndex: 50,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <Ops style={{ display: 'block', marginBottom: 4 }}>
            {item.contentType} · {item.status}
          </Ops>
          <h3
            id="slot-drawer-title"
            className="sf-h4"
            style={{ margin: 0, color: 'var(--sf-fg-1)' }}
          >
            {item.topic ?? 'Scheduled item'}
          </h3>
          <div
            className="sf-mono"
            style={{
              marginTop: 4,
              fontSize: 'var(--sf-text-xs)',
              color: 'var(--sf-fg-3)',
              letterSpacing: 'var(--sf-track-mono)',
            }}
          >
            {formatHour(when.getHours() + when.getMinutes() / 60, clock)} ·{' '}
            {when.toLocaleDateString()}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--sf-fg-3)',
            cursor: 'pointer',
            fontSize: 18,
            padding: 4,
            fontFamily: 'inherit',
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
      {item.draftPreview && (
        <p
          style={{
            margin: '12px 0 0',
            padding: 10,
            background: 'var(--sf-paper-sunken)',
            borderRadius: 'var(--sf-radius-sm)',
            fontSize: 'var(--sf-text-sm)',
            color: 'var(--sf-fg-2)',
            lineHeight: 'var(--sf-lh-normal)',
          }}
        >
          {item.draftPreview}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Button
          variant="danger"
          size="sm"
          onClick={() => void onCancel(item.id)}
          disabled={item.status === 'posted'}
        >
          Cancel slot
        </Button>
        {item.postUrl && (
          <Button variant="ghost" size="sm" onClick={() => window.open(item.postUrl!, '_blank')}>
            View post
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function mondayOf(d: Date): Date {
  const nd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = nd.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  nd.setDate(nd.getDate() + diff);
  return nd;
}

function addDays(d: Date, n: number): Date {
  const nd = new Date(d);
  nd.setDate(nd.getDate() + n);
  return nd;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hourToIso(h: number): string {
  const hr = Math.floor(h);
  const min = Math.round((h - hr) * 60);
  return `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
}

function itemToSlot(it: CalendarItem) {
  const d = new Date(it.scheduledAt);
  const dateKey = keyOf(d);
  const hour = d.getHours() + d.getMinutes() / 60;
  // Classify kind: contentType 'thread' / 'educational' / 'product' etc → post;
  // we treat anything that's a draft reply (topic starts with r/ or @) as reply.
  const topic = it.topic ?? '';
  const kind: 'reply' | 'post' =
    topic.startsWith('r/') || topic.startsWith('@') || it.contentType === 'engagement'
      ? 'reply'
      : 'post';
  const platform: 'reddit' | 'x' | 'hn' =
    it.channel === 'reddit'
      ? 'reddit'
      : it.channel === 'hn'
        ? 'hn'
        : 'x';
  const sent = it.status === 'posted';
  return {
    id: it.id,
    date: dateKey,
    hour,
    duration: 0.5,
    kind,
    platform,
    title: it.topic ?? it.contentType,
    sent,
  };
}
