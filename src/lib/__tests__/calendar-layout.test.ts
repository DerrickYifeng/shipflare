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
    ['content_post', 30],
    ['content_reply', 30],
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
  test('single 09:00 post -> full width, 24px tall', () => {
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
    expect(e.heightPx).toBe(24); // 30m -> half of 48
    expect(e.leftPct).toBe(0);
    expect(e.widthPct).toBe(100);
    expect(e.isOverflowPill).toBeFalsy();
  });

  test('three non-overlapping events each get full width', () => {
    const events = layoutDayEvents(
      [item('content_post', 9), item('interview', 11), item('content_post', 15)],
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
    // heights: 30, 60, 30 -> 24, 48, 24 px
    expect(events.map((e) => e.heightPx)).toEqual([24, 48, 24]);
  });
});
