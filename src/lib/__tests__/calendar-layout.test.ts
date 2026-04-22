import { describe, expect, test } from 'vitest';
import {
  computeCollapsedBands,
  durationForKind,
  type CalendarDay,
  type PlanItemKind,
} from '../calendar-layout';

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

  test('packed 09-17 yields no bands', () => {
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
