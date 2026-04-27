# Calendar time-grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the desktop `/calendar` week view with a Google-Calendar-style time grid that positions events vertically by their scheduled time, collapses empty ≥3h bands, and splits overlapping events side-by-side. Mobile agenda view and API payload unchanged.

**Architecture:** A new pure module `src/lib/calendar-layout.ts` computes duration, collapsed bands, and per-day positioned events (top/height/left/width). The view component `src/app/(app)/calendar/calendar-content.tsx` renders a CSS-grid time rail + 7 absolutely-positioned day columns, reusing the existing `ItemCard`/`StateDot`/`MobileStack`/`EmptyWeek`/nav pieces. All positioning math lives in the pure module so it is unit-testable without JSDOM.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Vitest 4 (node environment), existing `var(--sf-*)` CSS tokens in `src/app/globals.css`.

**Spec:** `docs/superpowers/specs/2026-04-22-calendar-time-grid-design.md`

---

## File map

Created:
- `src/lib/calendar-layout.ts` — pure helpers (duration map, bands, positioning).
- `src/lib/__tests__/calendar-layout.test.ts` — unit tests.

Modified:
- `src/app/(app)/calendar/calendar-content.tsx` — replace `DesktopGrid` + `DayColumn` with `TimeGrid`. Keep `MobileStack`, `ItemCard`, `StateDot`, `EmptyWeek`, `MetaLine`, nav, helpers.

Untouched:
- `src/app/api/calendar/route.ts`
- `src/hooks/use-calendar.ts`
- `src/components/x-growth/content-calendar.tsx`
- `src/components/calendar/unified-calendar.tsx`

## Conventions confirmed in-repo

- Tests live under `src/**/__tests__/**/*.test.ts` per `vitest.config.ts`. Do **not** colocate tests next to source.
- `pnpm test` runs `vitest run`. `pnpm test <path>` runs a single file.
- Build gate is `pnpm tsc --noEmit` (memory: vitest uses `isolatedModules`; tsc is the authoritative green).
- CSS tokens referenced (`--sf-bg-primary`, `--sf-bg-secondary`, `--sf-accent`, `--sf-fg-1/2/3/4`, `--sf-font-mono`, `--sf-shadow-card`, `--sf-shadow-card-hover`) already exist in `src/app/globals.css`.
- Commits follow `<type>(<scope>): <description>`. The repo disables trailer attribution via `~/.claude/settings.json`, so **do not** add `Co-Authored-By` lines.

---

## Task 1: Scaffold `calendar-layout.ts` with `durationForKind`

**Files:**
- Create: `src/lib/calendar-layout.ts`
- Create: `src/lib/__tests__/calendar-layout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/calendar-layout.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { durationForKind, type PlanItemKind } from '../calendar-layout';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/__tests__/calendar-layout.test.ts`
Expected: FAIL with `Cannot find module '../calendar-layout'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/calendar-layout.ts`:

```ts
/**
 * Pure layout helpers for the /calendar time grid. No React, no DOM.
 *
 * Consumed by `src/app/(app)/calendar/calendar-content.tsx`. All rendering
 * constants (hour height, band height, overflow threshold) are passed in by
 * the caller so tests can pin exact values.
 */

export type PlanItemKind =
  | 'content_post'
  | 'content_reply'
  | 'email_send'
  | 'interview'
  | 'setup_task'
  | 'launch_asset'
  | 'runsheet_beat'
  | 'metrics_compute'
  | 'analytics_summary';

/**
 * Synthetic duration for a plan item. `plan_items` stores only a start time;
 * the calendar view fakes a visual block length per kind. See the spec for
 * the rationale (meetings read longer than posts).
 */
export function durationForKind(kind: PlanItemKind): number {
  switch (kind) {
    case 'content_post':
    case 'content_reply':
    case 'email_send':
    case 'analytics_summary':
    case 'metrics_compute':
    case 'launch_asset':
      return 30;
    case 'interview':
    case 'setup_task':
    case 'runsheet_beat':
      return 60;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/__tests__/calendar-layout.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendar-layout.ts src/lib/__tests__/calendar-layout.test.ts
git commit -m "feat(calendar): add durationForKind helper"
```

---

## Task 2: Add `computeCollapsedBands`

**Files:**
- Modify: `src/lib/calendar-layout.ts`
- Modify: `src/lib/__tests__/calendar-layout.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/__tests__/calendar-layout.test.ts`:

```ts
import { computeCollapsedBands, type CalendarDay } from '../calendar-layout';

function day(date: string, starts: Array<{ kind: PlanItemKind; hour: number; minute?: number }>): CalendarDay {
  return {
    date,
    items: starts.map((s, i) => ({
      id: `${date}-${i}`,
      kind: s.kind,
      state: 'planned',
      channel: null,
      scheduledAt: `${date}T${String(s.hour).padStart(2, '0')}:${String(s.minute ?? 0).padStart(2, '0')}:00Z`,
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
    const days: CalendarDay[] = [day('2026-04-22', [{ kind: 'content_post', hour: 9 }])];
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/lib/__tests__/calendar-layout.test.ts`
Expected: FAIL — `computeCollapsedBands` is not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/calendar-layout.ts`:

```ts
export type PlanItemState =
  | 'planned'
  | 'drafted'
  | 'ready_for_review'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'superseded'
  | 'stale';

export interface CalendarItem {
  id: string;
  kind: PlanItemKind;
  state: PlanItemState;
  channel: string | null;
  scheduledAt: string;
  title: string;
  description: string | null;
  phase: string;
}

export interface CalendarDay {
  date: string;
  items: CalendarItem[];
}

export interface CollapsedBand {
  startHour: number; // inclusive, 0-23
  endHour: number; // exclusive, 1-24
}

export const BAND_COLLAPSE_MIN_HOURS = 3;

/**
 * Compute which hours of the day are "used" across the visible week and
 * which contiguous ≥3h runs of unused hours should render as a single
 * band. Used hours are computed as `max over 7 days` so hour labels on
 * the left rail stay aligned across columns.
 */
export function computeCollapsedBands(days: CalendarDay[]): {
  usedHours: Set<number>;
  bands: CollapsedBand[];
} {
  const usedHours = new Set<number>();

  for (const d of days) {
    for (const item of d.items) {
      const start = new Date(item.scheduledAt);
      const startHour = start.getUTCHours();
      const minutes = durationForKind(item.kind);
      // Expand across the duration. e.g. 60m starting 09:00 lights 9 and
      // 10 (since the block ends at 10:00 exclusive we only need hour 9,
      // but lighting hour 10 keeps a 1h buffer around meetings).
      const endMinutes = startHour * 60 + start.getUTCMinutes() + minutes;
      const endHourExclusive = Math.ceil(endMinutes / 60);
      for (let h = startHour; h < endHourExclusive && h < 24; h += 1) {
        usedHours.add(h);
      }
    }
  }

  const bands: CollapsedBand[] = [];
  let runStart: number | null = null;
  for (let h = 0; h <= 24; h += 1) {
    const isUsed = h < 24 && usedHours.has(h);
    if (!isUsed && runStart === null) {
      runStart = h;
    }
    if ((isUsed || h === 24) && runStart !== null) {
      const runLength = h - runStart;
      if (runLength >= BAND_COLLAPSE_MIN_HOURS) {
        bands.push({ startHour: runStart, endHour: h });
      }
      runStart = null;
    }
  }

  return { usedHours, bands };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/__tests__/calendar-layout.test.ts`
Expected: PASS (all previous + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendar-layout.ts src/lib/__tests__/calendar-layout.test.ts
git commit -m "feat(calendar): add computeCollapsedBands"
```

---

## Task 3: Add `hourToTopPx`

**Files:**
- Modify: `src/lib/calendar-layout.ts`
- Modify: `src/lib/__tests__/calendar-layout.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/__tests__/calendar-layout.test.ts`:

```ts
import { hourToTopPx } from '../calendar-layout';

const HOUR_H = 48;
const BAND_H = 28;

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/lib/__tests__/calendar-layout.test.ts`
Expected: FAIL — `hourToTopPx` is not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/calendar-layout.ts`:

```ts
/**
 * Convert a clock offset (minutes from midnight) to a pixel offset in the
 * rendered time grid, skipping past any collapsed bands that fall strictly
 * before the offset. Bands that straddle the offset shouldn't happen in
 * practice (bands only cover unused hours and an event's hour is always
 * used); defensively we treat them as if the offset landed at the band's
 * start.
 */
export function hourToTopPx(
  minutesFromMidnight: number,
  bands: CollapsedBand[],
  hourHeightPx: number,
  bandHeightPx: number,
): number {
  let px = 0;
  let minutesConsumed = 0;

  for (let h = 0; h < 24; h += 1) {
    if (minutesConsumed >= minutesFromMidnight) break;

    const band = bands.find((b) => b.startHour === h);
    if (band) {
      const bandEndMinutes = band.endHour * 60;
      if (minutesFromMidnight >= bandEndMinutes) {
        // Offset is past the band — consume the whole band as one row.
        px += bandHeightPx;
        minutesConsumed = bandEndMinutes;
        h = band.endHour - 1; // loop will re-increment
        continue;
      }
      // Defensive: offset inside the band — stop at the band's top edge.
      break;
    }

    const hourEndMinutes = (h + 1) * 60;
    const chunkMinutes =
      Math.min(hourEndMinutes, minutesFromMidnight) - h * 60;
    px += (chunkMinutes / 60) * hourHeightPx;
    minutesConsumed = Math.min(hourEndMinutes, minutesFromMidnight);
  }

  return px;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/__tests__/calendar-layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendar-layout.ts src/lib/__tests__/calendar-layout.test.ts
git commit -m "feat(calendar): add hourToTopPx with band-aware math"
```

---

## Task 4: Add `layoutDayEvents` (no overlap path)

**Files:**
- Modify: `src/lib/calendar-layout.ts`
- Modify: `src/lib/__tests__/calendar-layout.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/__tests__/calendar-layout.test.ts`:

```ts
import { layoutDayEvents, type PositionedEvent } from '../calendar-layout';

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
      [
        item('content_post', 9),
        item('interview', 11),
        item('content_post', 15),
      ],
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/lib/__tests__/calendar-layout.test.ts`
Expected: FAIL — `layoutDayEvents` is not exported.

- [ ] **Step 3: Implement (overlap-naive version — groups of 1 only)**

Append to `src/lib/calendar-layout.ts`:

```ts
export interface PositionedEvent {
  item: CalendarItem;
  topPx: number;
  heightPx: number;
  leftPct: number;
  widthPct: number;
  isOverflowPill?: boolean;
  /** Ids of the extra events collapsed into the pill. */
  overflowIds?: string[];
}

interface EventWithSpan {
  item: CalendarItem;
  startMinutes: number;
  endMinutes: number;
}

function toSpan(item: CalendarItem): EventWithSpan {
  const d = new Date(item.scheduledAt);
  const startMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const endMinutes = startMinutes + durationForKind(item.kind);
  return { item, startMinutes, endMinutes };
}

/**
 * Layout all events for a single day into absolutely-positioned boxes.
 * Non-overlapping events occupy the full column width; overlap grouping
 * and overflow-pill logic are added in later tasks.
 *
 * `columnWidthPx` is unused at this stage — Task 5 adds grouping and
 * Task 6 reads it to decide when to emit an overflow pill.
 */
export function layoutDayEvents(
  items: CalendarItem[],
  bands: CollapsedBand[],
  hourHeightPx: number,
  bandHeightPx: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  columnWidthPx: number,
): PositionedEvent[] {
  const spans = items
    .map(toSpan)
    .sort((a, b) => a.startMinutes - b.startMinutes);

  return spans.map((s) => {
    const topPx = hourToTopPx(s.startMinutes, bands, hourHeightPx, bandHeightPx);
    const bottomPx = hourToTopPx(s.endMinutes, bands, hourHeightPx, bandHeightPx);
    return {
      item: s.item,
      topPx,
      heightPx: Math.max(bottomPx - topPx, 20),
      leftPct: 0,
      widthPct: 100,
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/__tests__/calendar-layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendar-layout.ts src/lib/__tests__/calendar-layout.test.ts
git commit -m "feat(calendar): add layoutDayEvents for non-overlapping events"
```

---

## Task 5: Add overlap grouping (side-by-side)

**Files:**
- Modify: `src/lib/calendar-layout.ts`
- Modify: `src/lib/__tests__/calendar-layout.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/__tests__/calendar-layout.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/lib/__tests__/calendar-layout.test.ts`
Expected: FAIL — overlapping events still return `widthPct: 100`.

- [ ] **Step 3: Implement overlap grouping**

Replace the body of `layoutDayEvents` in `src/lib/calendar-layout.ts`:

```ts
export function layoutDayEvents(
  items: CalendarItem[],
  bands: CollapsedBand[],
  hourHeightPx: number,
  bandHeightPx: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  columnWidthPx: number,
): PositionedEvent[] {
  const spans = items
    .map(toSpan)
    .sort((a, b) => a.startMinutes - b.startMinutes);

  // Group transitively overlapping events. Sweep left→right; extend the
  // current group whenever the next event starts before the running max
  // end of the group.
  const groups: EventWithSpan[][] = [];
  let current: EventWithSpan[] = [];
  let currentMaxEnd = -Infinity;
  for (const s of spans) {
    if (current.length === 0 || s.startMinutes < currentMaxEnd) {
      current.push(s);
      currentMaxEnd = Math.max(currentMaxEnd, s.endMinutes);
    } else {
      groups.push(current);
      current = [s];
      currentMaxEnd = s.endMinutes;
    }
  }
  if (current.length > 0) groups.push(current);

  const out: PositionedEvent[] = [];
  for (const group of groups) {
    const n = group.length;
    const widthPct = 100 / n;
    group.forEach((s, i) => {
      const topPx = hourToTopPx(s.startMinutes, bands, hourHeightPx, bandHeightPx);
      const bottomPx = hourToTopPx(s.endMinutes, bands, hourHeightPx, bandHeightPx);
      out.push({
        item: s.item,
        topPx,
        heightPx: Math.max(bottomPx - topPx, 20),
        leftPct: i * widthPct,
        widthPct,
      });
    });
  }
  return out;
}
```

(The `columnWidthPx` parameter is still unused at this stage — Task 6 reads it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/__tests__/calendar-layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendar-layout.ts src/lib/__tests__/calendar-layout.test.ts
git commit -m "feat(calendar): group transitively overlapping events side-by-side"
```

---

## Task 6: Add overflow pill when column is too narrow

**Files:**
- Modify: `src/lib/calendar-layout.ts`
- Modify: `src/lib/__tests__/calendar-layout.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/__tests__/calendar-layout.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/lib/__tests__/calendar-layout.test.ts`
Expected: FAIL — first/second test cases produce three entries, none with `isOverflowPill`.

- [ ] **Step 3: Add the overflow-pill branch**

First, add a module-level constant below the existing `BAND_COLLAPSE_MIN_HOURS`:

```ts
/** Minimum rendered width (px) per card before the overlap layout falls
 * back to a single card + overflow pill. 80px fits the mono-font time
 * label comfortably; below this the card becomes unreadable. */
export const MIN_CARD_WIDTH_PX = 80;
```

Then, inside `layoutDayEvents`, drop the eslint-disable comment and the underscore-prefix note (the param is now used), and replace the entire "Build output" block — i.e. the loop starting `for (const group of groups) {` from Task 5 — with:

```ts
  for (const group of groups) {
    const n = group.length;
    const widthPct = 100 / n;
    const perWidthPx = columnWidthPx / n;

    if (n > 1 && perWidthPx < MIN_CARD_WIDTH_PX) {
      const first = group[0];
      const topPx = hourToTopPx(first.startMinutes, bands, hourHeightPx, bandHeightPx);
      const bottomPx = hourToTopPx(first.endMinutes, bands, hourHeightPx, bandHeightPx);
      const heightPx = Math.max(bottomPx - topPx, 20);
      out.push({
        item: first.item,
        topPx,
        heightPx,
        leftPct: 0,
        widthPct: 100,
      });
      out.push({
        item: first.item, // link target = first event
        topPx,
        heightPx,
        leftPct: 0,
        widthPct: 100,
        isOverflowPill: true,
        overflowIds: group.slice(1).map((s) => s.item.id),
      });
      continue;
    }

    group.forEach((s, i) => {
      const topPx = hourToTopPx(s.startMinutes, bands, hourHeightPx, bandHeightPx);
      const bottomPx = hourToTopPx(s.endMinutes, bands, hourHeightPx, bandHeightPx);
      out.push({
        item: s.item,
        topPx,
        heightPx: Math.max(bottomPx - topPx, 20),
        leftPct: i * widthPct,
        widthPct,
      });
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/__tests__/calendar-layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendar-layout.ts src/lib/__tests__/calendar-layout.test.ts
git commit -m "feat(calendar): emit overflow pill when overlap group is too narrow"
```

---

## Task 7: Replace `DesktopGrid` with `TimeGrid`

**Files:**
- Modify: `src/app/(app)/calendar/calendar-content.tsx`

- [ ] **Step 1: Delete the old desktop implementation**

In `src/app/(app)/calendar/calendar-content.tsx`:
- Remove the `DesktopGrid` function (the `function DesktopGrid(...) { ... }` block) and the `DayColumn` function.
- In the main `CalendarContent` return, replace `<DesktopGrid days={data.days} />` with `<TimeGrid days={data.days} weekStart={data.weekStart} />` (component defined in the next step).

- [ ] **Step 2: Update imports at the top**

Replace the existing React import:

```tsx
import { useCallback, useMemo, type CSSProperties } from 'react';
```

with:

```tsx
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
```

Add a new import for the layout module:

```tsx
import {
  computeCollapsedBands,
  hourToTopPx,
  layoutDayEvents,
  type CalendarDay as LayoutDay,
  type CalendarItem as LayoutItem,
  type PositionedEvent,
} from '@/lib/calendar-layout';
```

The existing `CalendarItem` / `CalendarDay` interface definitions in this file match the layout module's types structurally, so TypeScript will accept them without a cast. If a mismatch appears, re-export the layout module's types from the view file and delete the local duplicates.

Note: `CSSProperties` and `durationForKind` aren't used by the new code in this task. Keep `CSSProperties` in the import only if it's still referenced elsewhere in the file (it is — `ItemCard` uses it).

- [ ] **Step 3: Add layout constants**

Below the existing kind-style helpers (near the bottom of the file), add:

```tsx
const HOUR_HEIGHT_PX = 48;
const BAND_HEIGHT_PX = 28;
const LEFT_RAIL_PX = 56;
```

- [ ] **Step 4: Add the `TimeGrid` component (after `MobileStack`, before `ItemCard`)**

`TimeGrid` accepts an optional `gridRef` prop so the parent component can
scroll it (used in Task 8). Call sites without a ref still work.

```tsx
interface TimeGridProps {
  days: LayoutDay[];
  weekStart: string;
  gridRef?: RefObject<HTMLDivElement | null>;
}

function TimeGrid({ days, weekStart: _weekStart, gridRef }: TimeGridProps) {
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

function DayHeaderRow({ days, today }: { days: LayoutDay[]; today: string }) {
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
  day: LayoutDay;
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
        day.items as LayoutItem[],
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
      const minutes = now.getHours() * 60 + now.getMinutes();
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
```

- [ ] **Step 5: Verify typecheck and (visually) load page**

Run: `pnpm tsc --noEmit`
Expected: exit 0, no errors.

If you have a dev server handy, run `pnpm dev` and open `/calendar`. Otherwise the manual QA task below covers this.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/calendar/calendar-content.tsx"
git commit -m "feat(calendar): replace week-agenda desktop view with time grid"
```

---

## Task 8: Add "Now" nav button that scrolls to current time

**Files:**
- Modify: `src/app/(app)/calendar/calendar-content.tsx`

The `TimeGrid` component already accepts a `gridRef` prop from Task 7. This task only wires the ref + a `scrollToNow` callback at the `CalendarContent` level and adds the button to the nav cluster.

- [ ] **Step 1: Create the ref and scroll callback in `CalendarContent`**

Inside `CalendarContent`, near the existing `navTo` / `goThisWeek` callbacks:

```tsx
const gridRef = useRef<HTMLDivElement | null>(null);

const scrollToNow = useCallback(() => {
  const el = gridRef.current;
  if (!data || !el) return;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const { bands } = computeCollapsedBands(data.days as LayoutDay[]);
  const topPx = hourToTopPx(minutes, bands, HOUR_HEIGHT_PX, BAND_HEIGHT_PX);
  el.scrollTo({ top: Math.max(topPx - 120, 0), behavior: 'smooth' });
}, [data]);

const showNowButton = useMemo(() => {
  if (!data) return false;
  const todayYmd = todayYmdLocal();
  return data.days.some((d) => d.date === todayYmd);
}, [data]);
```

- [ ] **Step 2: Pass the ref into `TimeGrid`**

Change the `<TimeGrid ... />` call site to:

```tsx
<TimeGrid days={data.days} weekStart={data.weekStart} gridRef={gridRef} />
```

- [ ] **Step 3: Add the Now button to the nav cluster**

In the existing `nav` JSX, after the `Next` button, before the closing `</div>`, add:

```tsx
{showNowButton && (
  <Button variant="ghost" size="sm" onClick={scrollToNow}>
    Now
  </Button>
)}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/calendar/calendar-content.tsx"
git commit -m "feat(calendar): add Now button that scrolls grid to current time"
```

---

## Task 9: Final type check, lint, and manual QA

**Files:** none modified (verification only, unless bugs found).

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test src/lib/__tests__/calendar-layout.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 2: Run the type check (authoritative build gate)**

Run: `pnpm tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Manual QA checklist**

Start dev server: `pnpm dev`, open `http://localhost:3000/calendar`.

- [ ] Open `/calendar` on a week with items: a time rail appears on the left with hour labels (05:00, 06:00, …).
- [ ] A 30-minute `content_post` renders at ~24px tall; a 60-minute `interview` at ~48px tall.
- [ ] Empty 3h+ stretches render as a single thin divider row.
- [ ] Two items at the same time render side-by-side at 50%/50% width.
- [ ] Today column has an accent border, a subtle background wash, and a horizontal "now" line at the current local time.
- [ ] Clicking the `Now` button scrolls the grid so the now-line is visible near the top.
- [ ] Clicking an event card navigates to `/today?highlight=<id>` (unchanged behavior).
- [ ] Resize window below 880px: desktop grid hides, `MobileStack` agenda shows.
- [ ] On a week with zero items: `EmptyWeek` renders; no grid shown.
- [ ] Navigate prev/this week/next; grid reflows correctly; today indicator only appears on the week containing today.

- [ ] **Step 4: If any QA item fails, fix and commit incremental patches**

For each bug found:
1. Write a minimal failing test in `src/lib/__tests__/calendar-layout.test.ts` if it's a layout-math bug.
2. Fix the code.
3. Commit with `fix(calendar): <describe>`.

- [ ] **Step 5: Final commit (if nothing else to change)**

No-op. Close out the task.

---

## What's explicitly out of scope

- Month view / view-switcher — deferred per spec.
- Drag-to-reschedule or inline-edit — read-only stays.
- Changing `/api/calendar` response shape — unchanged.
- Multi-day events — no item kind currently spans days; out of scope.
- Timezone display — the API emits ISO strings already interpreted as local on render; we match the existing behavior.

## Rollback

This is view-layer only. To roll back: `git revert` the commits for tasks 1–8. The API and DB are untouched.
