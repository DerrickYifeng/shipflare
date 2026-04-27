import { describe, expect, test } from 'vitest';
import {
  computeCollapsedBands,
  durationForKind,
  hourToTopPx,
  layoutDayEvents,
  type CalendarDay,
  type CalendarItem,
  type PlanItemKind,
  type PositionedEvent,
} from '../calendar-layout';

const HOUR_H = 48;
const BAND_H = 28;

describe('durationForKind', () => {
  test.each<[PlanItemKind, number]>([
    ['content_post', 60],
    ['content_reply', 60],
    ['email_send', 30],
    ['analytics_summary', 30],
    ['metrics_compute', 30],
    ['launch_asset', 30],
    ['interview', 60],
    ['setup_task', 60],
    ['runsheet_beat', 60],
  ])('maps %s -> %i min', (kind, minutes) => {
    expect(durationForKind(kind)).toBe(minutes);
  });
});

function day(
  date: string,
  starts: Array<{ kind: PlanItemKind; hour: number; minute?: number }>
): CalendarDay {
  return {
    date,
    items: starts.map((s, i) => ({
      id: `${date}-${i}`,
      kind: s.kind,
      state: 'planned' as const,
      channel: null,
      scheduledAt: `${date}T${String(s.hour).padStart(2, '0')}:${String(
        s.minute ?? 0
      ).padStart(2, '0')}:00Z`,
      title: `item ${i}`,
      description: null,
      phase: 'foundation',
    })),
  };
}

describe('computeCollapsedBands', () => {
  test('empty week collapses into one full-day band', () => {
    const days: CalendarDay[] = [
      day('2026-04-20', []),
      day('2026-04-21', []),
      day('2026-04-22', []),
      day('2026-04-23', []),
      day('2026-04-24', []),
      day('2026-04-25', []),
      day('2026-04-26', []),
    ];
    const { bands, usedHours } = computeCollapsedBands(days);
    expect(usedHours.size).toBe(0);
    expect(bands).toEqual([{ startHour: 0, endHour: 24 }]);
  });

  test('single 09:00 post (30m) collapses before and after', () => {
    const days: CalendarDay[] = [
      day('2026-04-22', [{ kind: 'content_post', hour: 9 }]),
    ];
    const { bands, usedHours } = computeCollapsedBands(days);
    expect(usedHours.has(9)).toBe(true);
    expect(bands).toEqual([
      { startHour: 0, endHour: 9 },
      { startHour: 10, endHour: 24 },
    ]);
  });

  test('packed 09-17 yields no bands within the working day (only edges collapse)', () => {
    const days: CalendarDay[] = [
      day('2026-04-22', [
        { kind: 'interview', hour: 9 },
        { kind: 'interview', hour: 10 },
        { kind: 'interview', hour: 11 },
        { kind: 'interview', hour: 12 },
        { kind: 'interview', hour: 13 },
        { kind: 'interview', hour: 14 },
        { kind: 'interview', hour: 15 },
        { kind: 'interview', hour: 16 },
      ]),
    ];
    const { bands } = computeCollapsedBands(days);
    expect(bands).toEqual([
      { startHour: 0, endHour: 9 },
      { startHour: 17, endHour: 24 },
    ]);
  });

  test('2h gap between events stays un-collapsed (under threshold)', () => {
    const days: CalendarDay[] = [
      day('2026-04-22', [
        { kind: 'content_post', hour: 9 },
        { kind: 'content_post', hour: 12 },
      ]),
    ];
    // 09 used (post), 10 gap, 11 gap, 12 used → gap = 2h (hours 10-11),
    // under threshold, so no band collapses between them.
    const { bands } = computeCollapsedBands(days);
    expect(bands).toEqual([
      { startHour: 0, endHour: 9 },
      { startHour: 13, endHour: 24 },
    ]);
  });

  test('30-minute post at 08:45 lights hour 8 and hour 9 (spans the boundary)', () => {
    const days: CalendarDay[] = [
      day('2026-04-22', [{ kind: 'content_post', hour: 8, minute: 45 }]),
    ];
    const { usedHours } = computeCollapsedBands(days);
    expect(usedHours.has(8)).toBe(true);
    expect(usedHours.has(9)).toBe(true);
  });
});

describe('hourToTopPx', () => {
  test('no bands: 0h -> 0px, 9h -> 9 * 48', () => {
    expect(hourToTopPx(0, [], HOUR_H, BAND_H)).toBe(0);
    expect(hourToTopPx(9 * 60, [], HOUR_H, BAND_H)).toBe(9 * 48);
  });

  test('band entirely before the minute offset collapses hours to one band height', () => {
    // 00-09 collapsed (9h). Minute offset = 9h, 0min.
    // Expected top = 0 expanded hours before band * 48 + band_h = 28.
    expect(hourToTopPx(9 * 60, [{ startHour: 0, endHour: 9 }], HOUR_H, BAND_H)).toBe(28);
  });

  test('band entirely after the offset has no effect', () => {
    // minute offset = 5h. Band 10-13 is after. Top = 5 * 48.
    expect(hourToTopPx(5 * 60, [{ startHour: 10, endHour: 13 }], HOUR_H, BAND_H)).toBe(5 * 48);
  });

  test('30-minute offset adds half an hour', () => {
    // 09:30 with band 00-09 collapsed: band_h + 0.5 * 48 = 28 + 24 = 52.
    expect(hourToTopPx(9 * 60 + 30, [{ startHour: 0, endHour: 9 }], HOUR_H, BAND_H)).toBe(52);
  });
});

function item(kind: PlanItemKind, hour: number, minute = 0, id = `${hour}-${minute}`): CalendarItem {
  return {
    id,
    kind,
    state: 'planned',
    channel: null,
    scheduledAt: `2026-04-22T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`,
    title: `item ${id}`,
    description: null,
    phase: 'foundation',
  };
}

describe('layoutDayEvents — non-overlapping', () => {
  test('single 09:00 post -> full width, 48px tall', () => {
    const events = layoutDayEvents(
      [item('content_post', 9)],
      [{ startHour: 0, endHour: 9 }],
      HOUR_H,
      BAND_H,
      200,
    );
    expect(events).toHaveLength(1);
    const e = events[0] as PositionedEvent;
    expect(e.topPx).toBe(28); // band_h
    expect(e.heightPx).toBe(48); // 60m -> full HOUR_H
    expect(e.leftPct).toBe(0);
    expect(e.widthPct).toBe(100);
    expect(e.isOverflowPill).toBeFalsy();
  });

  test('three non-overlapping events each get full width', () => {
    const events = layoutDayEvents(
      [item('content_post', 9), item('interview', 11), item('email_send', 15)],
      [],
      HOUR_H,
      BAND_H,
      200,
    );
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.leftPct).toBe(0);
      expect(e.widthPct).toBe(100);
    }
    // heights: 60, 60, 30 min -> 48, 48, 24 px
    expect(events.map((e) => e.heightPx)).toEqual([48, 48, 24]);
  });
});

describe('layoutDayEvents — overlapping', () => {
  test('two posts at 08:00 split 50/50', () => {
    const events = layoutDayEvents(
      [item('content_post', 8, 0, 'a'), item('content_post', 8, 0, 'b')],
      [],
      HOUR_H,
      BAND_H,
      200,
    );
    expect(events.map((e) => e.widthPct)).toEqual([50, 50]);
    expect(events.map((e) => e.leftPct)).toEqual([0, 50]);
  });

  test('transitive overlap: A=08:00-08:30, B=08:15-08:45, C=08:40-09:10 -> all three share', () => {
    const events = layoutDayEvents(
      [
        item('content_post', 8, 0, 'a'),
        item('content_post', 8, 15, 'b'),
        item('content_post', 8, 40, 'c'),
      ],
      [],
      HOUR_H,
      BAND_H,
      300, // wide enough to avoid overflow pill
    );
    expect(events).toHaveLength(3);
    expect(events.every((e) => !e.isOverflowPill)).toBe(true);
    const widths = events.map((e) => Math.round(e.widthPct));
    expect(widths).toEqual([33, 33, 33]);
    expect(events.map((e) => Math.round(e.leftPct))).toEqual([0, 33, 67]);
  });

  test('disjoint events stay full width', () => {
    const events = layoutDayEvents(
      [item('content_post', 9), item('content_post', 14)],
      [],
      HOUR_H,
      BAND_H,
      200,
    );
    for (const e of events) {
      expect(e.widthPct).toBe(100);
      expect(e.leftPct).toBe(0);
    }
  });
});

describe('layoutDayEvents — overflow pill', () => {
  test('three overlaps in a narrow column emit first event + overflow pill', () => {
    const events = layoutDayEvents(
      [
        item('content_post', 8, 0, 'a'),
        item('content_post', 8, 0, 'b'),
        item('content_post', 8, 0, 'c'),
      ],
      [],
      HOUR_H,
      BAND_H,
      200, // 200 / 3 ≈ 66.7 < 80 -> overflow
    );
    expect(events).toHaveLength(2);
    const [first, pill] = events as [PositionedEvent, PositionedEvent];
    expect(first.item.id).toBe('a');
    expect(first.widthPct).toBe(100);
    expect(first.isOverflowPill).toBeFalsy();
    expect(pill.isOverflowPill).toBe(true);
    expect(pill.overflowIds).toEqual(['b', 'c']);
    expect(pill.item.id).toBe('a'); // link target points at first event
  });

  test('two overlaps in a narrow column also overflow', () => {
    // 2 events in 120px column -> 60px each < 80 -> overflow.
    const events = layoutDayEvents(
      [item('content_post', 8, 0, 'a'), item('content_post', 8, 0, 'b')],
      [],
      HOUR_H,
      BAND_H,
      120,
    );
    expect(events).toHaveLength(2);
    expect(events[0].widthPct).toBe(100);
    expect(events[1].isOverflowPill).toBe(true);
    expect(events[1].overflowIds).toEqual(['b']);
  });

  test('two overlaps in a wide column stay side-by-side', () => {
    const events = layoutDayEvents(
      [item('content_post', 8, 0, 'a'), item('content_post', 8, 0, 'b')],
      [],
      HOUR_H,
      BAND_H,
      200, // 100px each, above 80 -> OK
    );
    expect(events).toHaveLength(2);
    expect(events.every((e) => !e.isOverflowPill)).toBe(true);
  });
});
