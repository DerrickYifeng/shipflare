'use client';

/**
 * /calendar week-grid against `plan_items`. Reads `/api/calendar?weekStart=`
 * and renders 7 day columns with item cards. Mobile collapses to a stacked
 * list of days.
 *
 * Today column: accent-bordered header. Today's date is derived locally so
 * the highlight adapts to the user's browser TZ without a second server
 * round-trip.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import {
  computeCollapsedBands,
  hourToTopPx,
  layoutDayEvents,
  type CalendarDay,
  type CalendarItem,
  type PlanItemKind,
  type PlanItemState,
  type PositionedEvent,
} from '@/lib/calendar-layout';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { HeaderBar } from '@/components/layout/header-bar';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

interface CalendarResponse {
  weekStart: string;
  weekEnd: string;
  prev: string;
  next: string;
  days: CalendarDay[];
  totals: {
    scheduled: number;
    completed: number;
    skipped: number;
  };
}

const fetcher = (url: string): Promise<CalendarResponse> =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Calendar fetch failed (${r.status})`);
    return r.json() as Promise<CalendarResponse>;
  });

export function CalendarContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const weekStartParam = searchParams?.get('weekStart') ?? '';

  const swrKey = weekStartParam
    ? `/api/calendar?weekStart=${encodeURIComponent(weekStartParam)}`
    : '/api/calendar';
  const { data, error, isLoading } = useSWR<CalendarResponse>(swrKey, fetcher, {
    refreshInterval: 60_000,
  });

  const navTo = useCallback(
    (iso: string) => {
      const ymd = iso.slice(0, 10);
      router.push(`/calendar?weekStart=${ymd}`);
    },
    [router],
  );

  const goThisWeek = useCallback(() => {
    router.push('/calendar');
  }, [router]);

  const gridRef = useRef<HTMLDivElement | null>(null);

  const scrollToNow = useCallback(() => {
    const el = gridRef.current;
    if (!data || !el) return;
    const now = new Date();
    // UTC to match layoutDayEvents / computeCollapsedBands / NowLine positioning.
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const { bands } = computeCollapsedBands(data.days);
    const topPx = hourToTopPx(minutes, bands, HOUR_HEIGHT_PX, BAND_HEIGHT_PX);
    el.scrollTo({ top: Math.max(topPx - 120, 0), behavior: 'smooth' });
  }, [data]);

  const showNowButton = useMemo(() => {
    if (!data) return false;
    const todayYmd = todayYmdLocal();
    return data.days.some((d) => d.date === todayYmd);
  }, [data]);

  // Format label for the header nav. "Apr 14" / "This week" / "Apr 28".
  const navLabels = useMemo(() => {
    if (!data) return { prev: '', next: '', current: 'This week' };
    return {
      prev: shortMonthDay(data.prev),
      next: shortMonthDay(data.next),
      current: weekRangeLabel(data.weekStart, data.weekEnd),
    };
  }, [data]);

  const meta = data ? (
    <MetaLine
      scheduled={data.totals.scheduled}
      completed={data.totals.completed}
      skipped={data.totals.skipped}
    />
  ) : null;

  const nav = (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => data && navTo(data.prev)}
        disabled={!data}
        aria-label="Previous week"
      >
        ← {data ? navLabels.prev : ''}
      </Button>
      <Button variant="ghost" size="sm" onClick={goThisWeek}>
        This week
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => data && navTo(data.next)}
        disabled={!data}
        aria-label="Next week"
      >
        {data ? navLabels.next : ''} →
      </Button>
      {showNowButton && (
        <Button variant="ghost" size="sm" onClick={scrollToNow}>
          Now
        </Button>
      )}
    </div>
  );

  if (error) {
    return (
      <>
        <HeaderBar title="Calendar" />
        <div style={{ padding: '16px clamp(16px, 3vw, 32px)' }}>
          <EmptyState
            title="We couldn't load the calendar."
            hint="Try refreshing — if the problem sticks, ping support."
          />
        </div>
      </>
    );
  }

  if (isLoading || !data) {
    return (
      <>
        <HeaderBar title="Calendar" meta={meta} action={nav} />
        <div
          style={{
            padding: '16px clamp(16px, 3vw, 32px) 48px',
            textAlign: 'center',
            color: 'var(--sf-fg-4)',
            fontSize: 13,
          }}
        >
          Loading…
        </div>
      </>
    );
  }

  const totalItems = data.days.reduce((n, d) => n + d.items.length, 0);

  return (
    <>
      <HeaderBar title="Calendar" meta={meta} action={nav} />
      {totalItems === 0 ? (
        <EmptyWeek />
      ) : (
        <>
          <TimeGrid days={data.days} gridRef={gridRef} />
          <MobileStack days={data.days} />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Mobile stacked list
// ---------------------------------------------------------------------------

function MobileStack({ days }: { days: CalendarDay[] }) {
  const today = todayYmdLocal();
  return (
    <div
      className="calendar-mobile-stack"
      style={{
        padding: '0 clamp(16px, 3vw, 24px) 48px',
        display: 'none',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {days.map((d) => {
        const isToday = d.date === today;
        const label = dayColumnLabel(d.date);
        return (
          <section key={d.date}>
            <header
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                padding: '0 0 8px 12px',
                borderLeft: `2px solid ${
                  isToday ? 'var(--sf-accent)' : 'rgba(0,0,0,0.08)'
                }`,
                marginBottom: 4,
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--sf-font-mono)',
                  fontSize: 11,
                  letterSpacing: '-0.08px',
                  textTransform: 'uppercase',
                  color: isToday ? 'var(--sf-accent)' : 'var(--sf-fg-4)',
                  fontWeight: 500,
                }}
              >
                {label.weekday}
              </span>
              <span
                style={{
                  fontSize: 15,
                  fontWeight: 500,
                  color: 'var(--sf-fg-1)',
                  letterSpacing: '-0.16px',
                }}
              >
                {label.day}
              </span>
            </header>
            {d.items.length === 0 ? (
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--sf-fg-4)',
                  letterSpacing: '-0.12px',
                  fontStyle: 'italic',
                  padding: '4px 0 4px 14px',
                }}
              >
                Nothing scheduled · relax
              </div>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                {d.items.map((i) => (
                  <ItemCard key={i.id} item={i} />
                ))}
              </div>
            )}
          </section>
        );
      })}
      <style>{`
        @media (max-width: 880px) {
          .calendar-mobile-stack { display: flex !important; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time grid (desktop, ≥880 px)
// ---------------------------------------------------------------------------

const HOUR_HEIGHT_PX = 48;
const BAND_HEIGHT_PX = 28;
const LEFT_RAIL_PX = 56;

interface TimeGridProps {
  days: CalendarDay[];
  gridRef?: RefObject<HTMLDivElement | null>;
}

function TimeGrid({ days, gridRef }: TimeGridProps) {
  const { bands } = useMemo(() => computeCollapsedBands(days), [days]);

  const internalRef = useRef<HTMLDivElement | null>(null);
  const ref = gridRef ?? internalRef;
  const [columnWidthPx, setColumnWidthPx] = useState(140);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const width = el.getBoundingClientRect().width;
      const cols = (width - LEFT_RAIL_PX) / 7;
      setColumnWidthPx(Math.max(cols, 80));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  // Build the vertical track: either a 48px hour row or a 28px band row.
  const tracks = useMemo(() => {
    const out: Array<
      | { kind: 'hour'; hour: number }
      | { kind: 'band'; startHour: number; endHour: number }
    > = [];
    let h = 0;
    while (h < 24) {
      const band = bands.find((b) => b.startHour === h);
      if (band) {
        out.push({ kind: 'band', startHour: band.startHour, endHour: band.endHour });
        h = band.endHour;
      } else {
        out.push({ kind: 'hour', hour: h });
        h += 1;
      }
    }
    return out;
  }, [bands]);

  const today = todayYmdLocal();
  const totalHeight = tracks.reduce(
    (sum, t) => sum + (t.kind === 'hour' ? HOUR_HEIGHT_PX : BAND_HEIGHT_PX),
    0,
  );

  // Precompute each band's top-px offset (for the full-width label overlay).
  const bandPositions = useMemo(() => {
    return bands.map((b) => ({
      band: b,
      topPx: hourToTopPx(b.startHour * 60, bands, HOUR_HEIGHT_PX, BAND_HEIGHT_PX),
    }));
  }, [bands]);

  return (
    <div
      ref={ref}
      className="calendar-time-grid"
      style={{
        padding: '0 clamp(16px, 3vw, 32px) 48px',
        maxHeight: 'calc(100vh - 220px)',
        overflowY: 'auto',
      }}
    >
      <DayHeaderRow days={days} today={today} />
      <div
        style={{
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: `${LEFT_RAIL_PX}px repeat(7, minmax(0, 1fr))`,
          borderTop: '1px solid rgba(0,0,0,0.06)',
        }}
      >
        <HourRail tracks={tracks} />
        {days.map((d, dayIndex) => (
          <DayColumn
            key={d.date}
            day={d}
            dayIndex={dayIndex}
            tracks={tracks}
            bands={bands}
            columnWidthPx={columnWidthPx}
            isToday={d.date === today}
            totalHeight={totalHeight}
          />
        ))}
        {/* Full-width band labels painted on top of the columns. */}
        {bandPositions.map(({ band, topPx }) => (
          <div
            key={`band-label-${band.startHour}`}
            aria-hidden
            style={{
              position: 'absolute',
              left: LEFT_RAIL_PX,
              right: 0,
              top: topPx,
              height: BAND_HEIGHT_PX,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              fontFamily: 'var(--sf-font-mono)',
              color: 'var(--sf-fg-4)',
              letterSpacing: '-0.08px',
              textTransform: 'uppercase',
              pointerEvents: 'none',
            }}
          >
            — no events · {String(band.startHour).padStart(2, '0')}:00–
            {String(band.endHour).padStart(2, '0')}:00 —
          </div>
        ))}
      </div>
      <style>{`
        @media (max-width: 880px) {
          .calendar-time-grid { display: none !important; }
        }
      `}</style>
    </div>
  );
}

function DayHeaderRow({ days, today }: { days: CalendarDay[]; today: string }) {
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        background: 'var(--sf-bg-primary)',
        zIndex: 2,
        display: 'grid',
        gridTemplateColumns: `${LEFT_RAIL_PX}px repeat(7, minmax(0, 1fr))`,
        borderBottom: '1px solid rgba(0,0,0,0.06)',
      }}
    >
      <div />
      {days.map((d) => {
        const isToday = d.date === today;
        const label = dayColumnLabel(d.date);
        return (
          <div
            key={d.date}
            style={{
              padding: '10px 12px',
              borderLeft: `${isToday ? 2 : 1}px solid ${
                isToday ? 'var(--sf-accent)' : 'rgba(0,0,0,0.06)'
              }`,
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 6,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontFamily: 'var(--sf-font-mono)',
                letterSpacing: '-0.08px',
                textTransform: 'uppercase',
                color: isToday ? 'var(--sf-accent)' : 'var(--sf-fg-4)',
                fontWeight: 500,
              }}
            >
              {label.weekday}
            </span>
            <span
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--sf-fg-1)',
                letterSpacing: '-0.12px',
              }}
            >
              {label.day}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function HourRail({
  tracks,
}: {
  tracks: Array<
    | { kind: 'hour'; hour: number }
    | { kind: 'band'; startHour: number; endHour: number }
  >;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid rgba(0,0,0,0.06)',
      }}
    >
      {tracks.map((t, i) => {
        if (t.kind === 'band') {
          // Empty spacer — the full-width band label is painted by the
          // overlay in TimeGrid so we only need to reserve vertical space
          // here to keep the rail aligned with the day columns.
          return (
            <div
              key={`band-${t.startHour}`}
              style={{ height: BAND_HEIGHT_PX }}
            />
          );
        }
        return (
          <div
            key={`hour-${t.hour}`}
            style={{
              height: HOUR_HEIGHT_PX,
              paddingRight: 8,
              fontSize: 10,
              fontFamily: 'var(--sf-font-mono)',
              color: 'var(--sf-fg-4)',
              letterSpacing: '-0.08px',
              textAlign: 'right',
              transform: 'translateY(-6px)',
              // Hide the "00:00" label; the 0 row anchors visually without it.
              visibility: i === 0 && t.hour === 0 ? 'hidden' : 'visible',
            }}
          >
            {String(t.hour).padStart(2, '0')}:00
          </div>
        );
      })}
    </div>
  );
}

function DayColumn({
  day,
  dayIndex: _dayIndex,
  tracks,
  bands,
  columnWidthPx,
  isToday,
  totalHeight,
}: {
  day: CalendarDay;
  dayIndex: number;
  tracks: Array<
    | { kind: 'hour'; hour: number }
    | { kind: 'band'; startHour: number; endHour: number }
  >;
  bands: { startHour: number; endHour: number }[];
  columnWidthPx: number;
  isToday: boolean;
  totalHeight: number;
}) {
  const positioned = useMemo(
    () =>
      layoutDayEvents(
        day.items,
        bands,
        HOUR_HEIGHT_PX,
        BAND_HEIGHT_PX,
        columnWidthPx,
      ),
    [day.items, bands, columnWidthPx],
  );

  return (
    <div
      style={{
        position: 'relative',
        borderLeft: `${isToday ? 2 : 1}px solid ${
          isToday ? 'var(--sf-accent)' : 'rgba(0,0,0,0.06)'
        }`,
        background: isToday ? 'rgba(0, 122, 255, 0.025)' : 'transparent',
        minHeight: totalHeight,
      }}
    >
      <TrackGuides tracks={tracks} />
      {isToday && <NowLine bands={bands} />}
      {positioned.map((p) =>
        p.isOverflowPill ? (
          <OverflowPill key={`pill-${p.item.id}`} p={p} />
        ) : (
          <EventCard key={p.item.id} p={p} />
        ),
      )}
    </div>
  );
}

function TrackGuides({
  tracks,
}: {
  tracks: Array<
    | { kind: 'hour'; hour: number }
    | { kind: 'band'; startHour: number; endHour: number }
  >;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {tracks.map((t) => (
        <div
          key={t.kind === 'hour' ? `hg-${t.hour}` : `bg-${t.startHour}`}
          style={{
            height: t.kind === 'hour' ? HOUR_HEIGHT_PX : BAND_HEIGHT_PX,
            borderTop: '1px solid rgba(0,0,0,0.04)',
            background:
              t.kind === 'band' ? 'rgba(0,0,0,0.015)' : 'transparent',
          }}
        />
      ))}
    </div>
  );
}

function NowLine({ bands }: { bands: { startHour: number; endHour: number }[] }) {
  const [topPx, setTopPx] = useState<number | null>(null);
  useEffect(() => {
    const compute = () => {
      const now = new Date();
      // UTC to match layoutDayEvents / computeCollapsedBands positioning.
      const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
      setTopPx(hourToTopPx(minutes, bands, HOUR_HEIGHT_PX, BAND_HEIGHT_PX));
    };
    compute();
    const t = window.setInterval(compute, 60_000);
    return () => window.clearInterval(t);
  }, [bands]);
  if (topPx === null) return null;
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: topPx,
        height: 1,
        background: 'var(--sf-accent)',
        boxShadow: '0 0 0 1px rgba(0, 122, 255, 0.15)',
        zIndex: 1,
        pointerEvents: 'none',
      }}
    />
  );
}

function EventCard({ p }: { p: PositionedEvent }) {
  const kindStyle = kindStyles(p.item.kind);
  const stateDot = stateDotStyles(p.item.state);
  const dimmed = p.item.state === 'skipped' || p.item.state === 'completed';
  const compact = p.heightPx < 40;
  return (
    <Link
      href={`/today?highlight=${p.item.id}`}
      style={{
        position: 'absolute',
        top: p.topPx,
        left: `calc(${p.leftPct}% + 2px)`,
        width: `calc(${p.widthPct}% - 4px)`,
        height: Math.max(p.heightPx - 2, 18),
        background: 'var(--sf-bg-primary)',
        borderRadius: 6,
        borderLeft: `3px solid ${kindStyle.accent}`,
        boxShadow: 'var(--sf-shadow-card)',
        textDecoration: 'none',
        color: 'inherit',
        padding: compact ? '3px 6px' : '6px 8px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 0 : 2,
        opacity: dimmed ? 0.6 : 1,
        zIndex: 2,
        transition: 'box-shadow 150ms, transform 150ms cubic-bezier(0.16,1,0.3,1)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-1px)';
        e.currentTarget.style.boxShadow = 'var(--sf-shadow-card-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = 'var(--sf-shadow-card)';
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 10,
          fontFamily: 'var(--sf-font-mono)',
          letterSpacing: '-0.08px',
          textTransform: 'uppercase',
          color: kindStyle.inkColor,
          fontWeight: 500,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        <span>{formatClock(p.item.scheduledAt)}</span>
        <span style={{ color: 'rgba(0,0,0,0.2)' }}>·</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {kindStyle.label}
        </span>
        <span style={{ flex: 1 }} />
        <StateDot spec={stateDot} />
      </div>
      {!compact && (
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--sf-fg-1)',
            letterSpacing: '-0.12px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {p.item.title}
        </div>
      )}
      {compact && (
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: 'var(--sf-fg-1)',
            letterSpacing: '-0.12px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {p.item.title}
        </span>
      )}
    </Link>
  );
}

function OverflowPill({ p }: { p: PositionedEvent }) {
  return (
    <Link
      href={`/today?highlight=${p.item.id}`}
      style={{
        position: 'absolute',
        top: p.topPx + Math.max(p.heightPx - 22, 4),
        right: 4,
        padding: '2px 8px',
        fontSize: 10,
        fontFamily: 'var(--sf-font-mono)',
        textTransform: 'uppercase',
        background: 'var(--sf-fg-1)',
        color: 'var(--sf-bg-primary)',
        borderRadius: 10,
        textDecoration: 'none',
        zIndex: 3,
        letterSpacing: '-0.08px',
      }}
      title={`${(p.overflowIds ?? []).length} more overlapping`}
    >
      +{(p.overflowIds ?? []).length} more
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Item card
// ---------------------------------------------------------------------------

function ItemCard({ item }: { item: CalendarItem }) {
  const kindStyle = kindStyles(item.kind);
  const stateDot = stateDotStyles(item.state);
  const dimmed = item.state === 'skipped' || item.state === 'completed';
  const cardStyle: CSSProperties = {
    display: 'block',
    textDecoration: 'none',
    color: 'inherit',
    background: 'var(--sf-bg-primary)',
    borderRadius: 8,
    padding: '10px 10px 10px 12px',
    borderLeft: `3px solid ${kindStyle.accent}`,
    opacity: dimmed ? 0.55 : 1,
    transition:
      'transform 150ms cubic-bezier(0.16,1,0.3,1), box-shadow 150ms',
  };
  return (
    <Link
      href={`/today?highlight=${item.id}`}
      style={cardStyle}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-1px)';
        e.currentTarget.style.boxShadow = 'var(--sf-shadow-card-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10,
          fontFamily: 'var(--sf-font-mono)',
          letterSpacing: '-0.08px',
          textTransform: 'uppercase',
          color: kindStyle.inkColor,
          fontWeight: 500,
        }}
      >
        <span>{formatClock(item.scheduledAt)}</span>
        <span style={{ color: 'rgba(0,0,0,0.2)' }}>·</span>
        <span>{kindStyle.label}</span>
        <span style={{ flex: 1 }} />
        <StateDot spec={stateDot} />
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--sf-fg-1)',
          letterSpacing: '-0.12px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {item.title}
      </div>
      {item.channel && !isManualKind(item.kind) && (
        <span
          style={{
            display: 'inline-block',
            marginTop: 6,
            padding: '1px 6px',
            borderRadius: 4,
            background: 'rgba(0,0,0,0.05)',
            color: 'var(--sf-fg-3)',
            fontSize: 10,
            fontFamily: 'var(--sf-font-mono)',
            letterSpacing: '-0.08px',
            textTransform: 'uppercase',
            fontWeight: 500,
          }}
        >
          {channelLabel(item.channel)}
        </span>
      )}
    </Link>
  );
}

function StateDot({
  spec,
}: {
  spec: { color: string; fill: 'solid' | 'ring' | 'pulse' };
}) {
  if (spec.fill === 'ring') {
    return (
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          border: `1.5px solid ${spec.color}`,
          display: 'inline-block',
          flexShrink: 0,
        }}
      />
    );
  }
  if (spec.fill === 'pulse') {
    return (
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: spec.color,
          boxShadow: `0 0 0 3px ${spec.color}22`,
          animation: 'sf-pulse 1.5s cubic-bezier(0.4,0,0.6,1) infinite',
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: spec.color,
        flexShrink: 0,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Empty week
// ---------------------------------------------------------------------------

function EmptyWeek() {
  return (
    <div
      style={{
        padding: '24px clamp(16px, 3vw, 32px) 48px',
      }}
    >
      <EmptyState
        title="No items this week."
        hint="Re-plan from /settings to regenerate your week."
        action={
          <Link
            href="/settings"
            style={{
              fontSize: 13,
              color: 'var(--sf-accent)',
              letterSpacing: '-0.12px',
              textDecoration: 'underline',
            }}
          >
            Go to Settings
          </Link>
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface KindStyle {
  label: string;
  accent: string;
  inkColor: string;
}

function kindStyles(k: PlanItemKind): KindStyle {
  switch (k) {
    case 'content_post':
      return {
        label: 'Post',
        accent: 'var(--sf-accent)',
        inkColor: 'var(--sf-link)',
      };
    case 'content_reply':
      return {
        label: 'Reply',
        accent: 'var(--sf-accent-light)',
        inkColor: 'var(--sf-link)',
      };
    case 'email_send':
      return {
        label: 'Email',
        accent: 'var(--sf-success)',
        inkColor: 'var(--sf-success-ink)',
      };
    case 'interview':
      return {
        label: 'Interview',
        accent: 'var(--sf-fg-3)',
        inkColor: 'var(--sf-fg-3)',
      };
    case 'setup_task':
      return {
        label: 'Setup',
        accent: 'var(--sf-fg-3)',
        inkColor: 'var(--sf-fg-3)',
      };
    case 'launch_asset':
      return {
        label: 'Launch',
        accent: 'var(--sf-warning-ink)',
        inkColor: 'var(--sf-warning-ink)',
      };
    case 'runsheet_beat':
      return {
        label: 'Runsheet',
        accent: 'var(--sf-warning-ink)',
        inkColor: 'var(--sf-warning-ink)',
      };
    case 'metrics_compute':
      return {
        label: 'Metrics',
        accent: 'var(--sf-fg-4)',
        inkColor: 'var(--sf-fg-4)',
      };
    case 'analytics_summary':
      return {
        label: 'Summary',
        accent: 'var(--sf-fg-4)',
        inkColor: 'var(--sf-fg-4)',
      };
  }
}

function stateDotStyles(s: PlanItemState): {
  color: string;
  fill: 'solid' | 'ring' | 'pulse';
} {
  switch (s) {
    case 'ready_for_review':
      return { color: 'var(--sf-accent)', fill: 'pulse' };
    case 'approved':
    case 'executing':
      return { color: 'var(--sf-accent)', fill: 'solid' };
    case 'drafted':
      return { color: 'var(--sf-accent)', fill: 'ring' };
    case 'completed':
      return { color: 'var(--sf-success)', fill: 'solid' };
    case 'skipped':
      return { color: 'rgba(0,0,0,0.32)', fill: 'ring' };
    case 'failed':
      return { color: 'var(--sf-error)', fill: 'solid' };
    case 'planned':
    case 'superseded':
    case 'stale':
      return { color: 'rgba(0,0,0,0.24)', fill: 'ring' };
  }
}

function isManualKind(k: PlanItemKind): boolean {
  return k === 'interview' || k === 'setup_task' || k === 'runsheet_beat';
}

function channelLabel(channel: string): string {
  if (channel === 'x') return 'X';
  if (channel === 'reddit') return 'Reddit';
  if (channel === 'email') return 'Email';
  return channel;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function shortMonthDay(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function weekRangeLabel(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(new Date(end).getTime() - 1);
  const fmt: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return `${s.toLocaleDateString(undefined, fmt)} – ${e.toLocaleDateString(undefined, fmt)}`;
}

function dayColumnLabel(ymd: string): { weekday: string; day: string } {
  // Parse as UTC so the TZ offset doesn't shift the column by a day for
  // users right around midnight.
  const d = new Date(`${ymd}T00:00:00Z`);
  const weekday = d.toLocaleDateString(undefined, {
    weekday: 'short',
    timeZone: 'UTC',
  });
  const day = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return { weekday, day };
}

function todayYmdLocal(): string {
  const n = new Date();
  const y = n.getUTCFullYear();
  const m = String(n.getUTCMonth() + 1).padStart(2, '0');
  const d = String(n.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function MetaLine({
  scheduled,
  completed,
  skipped,
}: {
  scheduled: number;
  completed: number;
  skipped: number;
}) {
  const sep = (
    <span
      aria-hidden
      style={{ margin: '0 6px', color: 'var(--sf-fg-4)' }}
    >
      ·
    </span>
  );
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ color: 'var(--sf-fg-2)', fontWeight: 500 }}>
        {scheduled} scheduled
      </span>
      {sep}
      <span>{completed} completed</span>
      {sep}
      <span>{skipped} skipped</span>
    </span>
  );
}
