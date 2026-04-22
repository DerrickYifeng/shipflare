# Calendar time-grid redesign

**Date:** 2026-04-22
**Status:** Approved for implementation planning

## Problem

The current `/calendar` page renders a 7-column row of day cards, each listing
its items vertically. It reads as a week agenda, not a calendar — there is no
time axis, so an 08:00 post and an 18:00 interview look visually identical
except for the mono-font timestamp in the card header. Users have asked for
something that looks "like a real calendar".

Reference: `src/app/(app)/calendar/calendar-content.tsx` as of the parent commit.

## Goal

Replace the desktop week view with a Google-Calendar-style time grid where
events are positioned vertically by their scheduled time. Keep the data
contract and the mobile view unchanged.

Non-goals:

- Month view. (Possible future zoom-out; out of scope for this spec.)
- Editing / drag-to-reschedule. Read-only view, same as today.
- Changing the API payload shape.

## Summary of decisions

| Decision          | Choice                                                             |
| ----------------- | ------------------------------------------------------------------ |
| Time window       | Fixed 00:00 → 24:00 with collapsed "no events" bands of ≥3h        |
| Event duration    | Kind-based: 30min for posts/replies/email/metrics; 60min for meetings |
| Overlap handling  | Side-by-side, split column width                                   |
| Mobile            | Unchanged — keep existing stacked-list agenda                      |
| API               | Unchanged                                                          |

## Layout

Desktop grid (≥881px):

```
┌────────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┐
│        │ MON  │ TUE  │ WED  │ THU  │ FRI  │ SAT  │ SUN  │
│        │Apr 20│Apr 21│Apr 22│Apr 23│Apr 24│Apr 25│Apr 26│
├────────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┤
│ — no events · 00:00–04:00 ———————————————————————————— │
├────────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┤
│ 05:00  │[SETUP│      │      │      │      │      │      │
│        │Voice]│      │      │      │      │      │      │
│ 06:00  │      │      │      │      │      │      │      │
│ 07:00  │      │[INT  │      │      │      │      │      │
│        │      │Run5] │      │      │      │      │      │
│ 08:00  │[POST │      │      │      │      │      │      │
│        │Open] │      │      │      │      │      │      │
...
```

Dimensions:

- **Hour height:** 48px (30min = 24px, 60min = 48px).
- **Left rail width:** 56px. Hour labels every 1h, mono font, using existing
  `var(--sf-font-mono)` token and `var(--sf-fg-4)` color.
- **Day column:** flex 1/7 of remaining width. Minimum 92px before the mobile
  breakpoint kicks in.
- **Collapsed band height:** 28px. Renders full-width across all 7 columns
  with a centered label `— no events · HH:MM–HH:MM`, using the same mono/fg-4
  treatment as the hour rail.
- **Header row:** `position: sticky; top: 0;` so it stays visible while the
  grid scrolls inside its container. Today's header uses the existing accent
  border treatment from the current `DayColumn`.
- **"Now" line:** on the current week, a 1px horizontal line at the local-time
  position, colored `var(--sf-accent)`, drawn only inside the today column.

### Visual continuity

Colors, typography, shadows, and the item-card anatomy (time · kind · title,
channel pill, state dot) are reused from the current `ItemCard` in
`calendar-content.tsx`. Cards keep their `Link` to `/today?highlight=<id>` and
their existing hover lift.

## Collapsed bands

Motivation: most weeks have long empty stretches (midnight–5am, late evening).
Rendering 24h × 48px = 1152px when only 4h of the day is used wastes space
without adding context.

Algorithm:

1. Bucket all events in the visible week into their start hour (0–23), taking
   the max over 7 days — i.e. an hour is "used" if any day has an event
   starting in it. (Simpler than per-day collapse; keeps hour labels aligned
   across columns.)
2. Expand usage to include each event's duration band (start hour through
   `ceil((start + duration) / 60)`).
3. Find contiguous runs of **unused hours of length ≥3**.
4. Each run renders as one 28px divider replacing those hours. All other
   hours render at full 48px.

Threshold is a module-level constant so it's easy to tune:

```ts
const BAND_COLLAPSE_MIN_HOURS = 3;
```

## Event duration

Items in `plan_items` store a start time but no duration. We synthesize:

| Kind                | Duration |
| ------------------- | -------- |
| `content_post`      | 30min    |
| `content_reply`     | 30min    |
| `email_send`        | 30min    |
| `analytics_summary` | 30min    |
| `metrics_compute`   | 30min    |
| `launch_asset`      | 30min    |
| `interview`         | 60min    |
| `setup_task`        | 60min    |
| `runsheet_beat`     | 60min    |

Exposed as a pure helper `durationForKind(kind: PlanItemKind): number`.

## Overlap layout

Per day, after filtering to that day's events:

1. Sort by `scheduledAt` ascending.
2. Sweep through events, grouping any pair whose `[start, start+duration)`
   intervals intersect. Use transitive grouping: if A overlaps B and B
   overlaps C, all three go in one group even if A doesn't touch C directly.
3. For a group of size N, each event gets
   - `width = 100% / N` (minus a 2px gutter on both sides)
   - `left = i / N × 100%` (where `i` is sort index within the group)
4. If `columnWidthPx / N` would compute to under **80px**, render the first
   event full-width and emit one extra `PositionedEvent` with
   `isOverflowPill: true` carrying the remaining overlapping items' ids as
   metadata; the component renders that as a `+{N-1} more` pill pinned to
   the card's bottom-right, linking to
   `/today?highlight=<first overlapping id>`. This case is rare on typical
   desktop widths but prevents the layout from exploding on a 3-way overlap
   near the mobile breakpoint.

   `columnWidthPx` is measured once from the grid container via
   `getBoundingClientRect` on mount / resize and passed into
   `layoutDayEvents`, so the layout helper stays pure and testable.

## Mobile (≤880px)

Unchanged. The existing `MobileStack` component in `calendar-content.tsx`
continues to render the week as a stacked list of days with `ItemCard`s. This
matches Google Calendar's behavior of degrading to agenda on narrow screens
and is much more usable than a squeezed time grid.

## Header & nav

Unchanged behavior for:

- Prev / This week / Next buttons
- Meta line (`6 scheduled · 0 completed · 0 skipped`)

One addition: when the visible week contains today's date, show a small
**Now** ghost button in the nav cluster. Clicking it scrolls the grid
container so the current-time line is ~1/3 from the top.

## Empty week

Unchanged. When `totalItems === 0`, render the existing `EmptyWeek` component.
The grid itself is not rendered at all in that case, so collapsed bands and
overlap logic don't need to handle the empty case.

## File plan

New / changed:

- `src/app/(app)/calendar/calendar-content.tsx` — replace `DesktopGrid` and
  `DayColumn` with a new `TimeGrid` component that uses the helpers below.
  `MobileStack`, `ItemCard`, `EmptyWeek`, and the meta/nav pieces stay.
- `src/lib/calendar-layout.ts` — new pure module:
  - `durationForKind(kind: PlanItemKind): number`
  - `computeCollapsedBands(days: CalendarDay[]): { usedHours: Set<number>; bands: { startHour: number; endHour: number }[] }`
  - `hourToTopPx(minutesFromMidnight: number, bands, hourHeight, bandHeight): number`
    — turns a minute offset into a pixel offset that accounts for any
    collapsed bands earlier in the day.
  - `layoutDayEvents(items: CalendarItem[], bands, hourHeight, bandHeight, columnWidthPx): PositionedEvent[]`
    where `PositionedEvent` carries `{ item, topPx, heightPx, leftPct, widthPct, isOverflowPill?, overflowIds? }`.
    Uses `hourToTopPx` internally so returned pixel offsets are final;
    uses `columnWidthPx` to decide when to emit an overflow pill.
- `src/lib/calendar-layout.test.ts` — Vitest tests for the helpers.

Unchanged:

- `src/app/api/calendar/route.ts` — same payload.
- `src/hooks/use-calendar.ts` — still used only by the old x-growth view.
- `src/components/x-growth/content-calendar.tsx` — out of scope.

## Testing

Unit tests (Vitest) for `calendar-layout.ts`:

- `durationForKind` maps each kind to its expected minutes; fails the test
  suite if a new `PlanItemKind` is added without a mapping (use exhaustive
  switch with a `never`-typed default).
- `computeCollapsedBands`:
  - No events → one band spanning 00:00–24:00.
  - Single event at 09:00 (30min) → bands for 00:00–09:00 and 10:00–24:00,
    both ≥3h so both collapse.
  - Events densely packed 09:00–17:00 → no bands.
  - Adjacent 2h empty gap between events → no band (under threshold).
- `layoutDayEvents`:
  - Two events at 08:00 with 30min each and `columnWidthPx = 200` →
    side-by-side, `widthPct = 50`, `leftPct = 0` and `50`.
  - Three transitive overlaps at `columnWidthPx = 200` → all three split
    into thirds (200/3 ≈ 67 < 80 would trigger overflow, so pass
    `columnWidthPx = 300` here to verify the happy path).
  - Three transitive overlaps at `columnWidthPx = 200` → first full-width,
    one overflow pill carrying the other two ids.
  - Non-overlapping events → all `widthPct = 100`, `leftPct = 0`.
  - Event inside a collapsed band can't occur: step 1 of
    `computeCollapsedBands` always adds an event's start hour (and step 2
    its duration band) to `usedHours`, so no band can span an event's
    start.

Visual / manual:

- Open `/calendar` on a week with mixed kinds; confirm 30min vs 60min heights.
- Scroll to a week with a packed morning and empty afternoon; confirm the
  afternoon collapses into one band.
- Resize the window below 880px; confirm the mobile stack view renders.
- On today's week, confirm the "Now" line appears in the today column at
  the local-time offset and the Now button scrolls to it.

## Rollout

Ship behind no flag. The API is unchanged; worst case a visual regression
ships and we roll back. Manual QA on `/calendar` before merging is enough —
this is pure view-layer work.

## Open questions (resolved)

- **Hour height (48px)** — accepted.
- **Band threshold (3h)** — accepted. Lives as a module constant so we can
  tune without re-speccing.
- **Kind → duration map** — accepted as above.
- **Mobile** — stay with the existing agenda view.
