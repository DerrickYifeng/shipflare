# Remove post scheduling

**Date:** 2026-05-10
**Status:** Approved (brainstorming → writing-plans)
**Scope:** ShipFlare — remove all post-scheduling code paths and rebuild the
calendar as a calendar-shaped todo list.

## Goal

Strip every "schedule the post for later" code path. The user approves a
draft → ShipFlare publishes it now (X via API, Reddit via handoff). No
delay, no pacer, no per-day caps, no quiet hours, no rescheduling, no
hour-of-day grid. The calendar page survives as a 7-day visual but each
day becomes a stacked ordered todo list instead of a time-positioned
event grid.

## Non-goals

- Cross-platform posting parity changes (Reddit handoff stays handoff).
- Reply-card pipeline changes beyond removing the queued-ETA chip.
- Engagement monitoring delays (`enqueueEngagement(delayMs)` is unrelated
  — those are check-in pings at +15/30/60min post-publish, not post
  scheduling, and stay as-is).
- Replacing the daily-cap / quiet-hours guardrails with anything else.
  User accepted the trade-off ("Remove everything").

## Decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Calendar layout | Day-sectioned, ordered within day. Keep 7-day week visual. |
| `plan_items.scheduledAt` future | Drop the column. Add `due_date` (date) + `sort_order` (int). |
| X post button | Single **Post** button that fires the X API directly. No compose-tab handoff. |
| Daily cap + quiet hours | Remove. No replacement guardrail. |
| Existing scheduled rows | Discard (dev DB only). |

## Section 1 — Schema

Drizzle migration:

```sql
-- plan_items
ALTER TABLE plan_items DROP COLUMN scheduled_at;
ALTER TABLE plan_items ADD COLUMN due_date date NOT NULL;
ALTER TABLE plan_items ADD COLUMN sort_order integer NOT NULL DEFAULT 0;

DROP INDEX plan_items_user_state_scheduled_idx;
CREATE INDEX plan_items_user_state_due_idx
  ON plan_items (user_id, state, due_date, sort_order);
```

Drizzle schema (`src/lib/db/schema/plan-items.ts`):

```ts
dueDate: date('due_date', { mode: 'date' }).notNull(),
sortOrder: integer('sort_order').notNull().default(0),
```

The other two indexes on `plan_items` are unaffected
(`plan_items_plan_idx`, `plan_items_user_kind_state_idx`).

The dev DB is wiped — no data preservation logic.

## Section 2 — Pacer + approve flow

**Deleted files:**
- `src/lib/posting-pacer.ts`
- `src/lib/__tests__/posting-pacer.test.ts`
- `src/app/api/today/[id]/reschedule/route.ts`

**`src/lib/platform-config.ts`:**
- Drop the `posting:` block from every `PLATFORMS[*]` entry
  (`tiers`, `quietHoursUTC`).
- Drop `PostingConfig` / `PostingTier` types.

**`src/lib/approve-dispatch.ts`:**

```ts
export type DispatchResult =
  | { kind: 'handoff'; intentUrl: string }
  | { kind: 'queued' };
```

- Drop `connectedAgeDays` from `DispatchInput`.
- Drop the `computeNextSlot` call and the deferred-result branch.
- X original_post path → `{ kind: 'queued' }`. Caller flips draft status
  to `approved`, worker fires the X API immediately.

**`src/lib/queue/index.ts`:**

```ts
// Before
export async function enqueuePosting(data, opts: { delayMs?: number } = {}) { ... }
// After
export async function enqueuePosting(data: PostingJobData): Promise<void>
```

BullMQ `delay` field removed from the `postingQueue.add` call (jobs fire
immediately on enqueue).

**`src/app/api/today/[id]/approve/route.ts`:**
- Drop the `connectedAgeDays` computation.
- `applyDispatchResult` loses the `deferred` branch.
- Queued response shape: `{ success: true, queued: true }` (no `delayMs`).

**`src/app/api/today/[id]/post-now/route.ts`:** delete the file. With no
delay, the approve path IS post-now. Remove `postNow` from
`use-today.ts`, drop the queued-API branch in PostCard.

## Section 3 — Calendar UI

**`src/app/api/calendar/route.ts`:**
- Query bounds use `due_date` (date math, not timestamp math). Order:
  `due_date ASC, sort_order ASC`.
- Response shape unchanged at the day-bucket level. Item DTO drops
  `scheduledAt`; keeps `id, kind, state, channel, title, description, phase`.
- `totals` block unchanged.

**`src/app/(app)/calendar/calendar-content.tsx`:**
- Replace the desktop time-grid with a 7-column flex grid. Each column =
  one day; column contents = day header + stacked item cards in
  `sort_order`.
- Mobile (<880px): same items, vertical day-section stack (close to the
  existing `MobileStack`).
- Item card: kind glyph, title, channel chip, state dot. No clock label.
  No hover preview card.
- Keep week navigation (← Prev / This week / Next →), today-column
  accent border, the meta line (`X scheduled · Y completed · Z skipped`).
- Empty day renders "— nothing today" in muted mono.

**Deleted:**
- `src/lib/calendar-layout.ts` (hour bands, event positioning math).
- `src/lib/__tests__/calendar-layout.test.ts`.
- `EventHoverCard`, `EventCard`, `OverflowPill`, `NowLine`, `HourRail`,
  `TrackGuides`, `TimeGrid`, `DayHeaderRow`, `computeCollapsedBands`
  usage — anything that consumed `calendar-layout.ts`.

## Section 4 — PostCard + ReplyCard

**`src/app/(app)/today/_components/post-card.tsx`:**
- Single primary `Post` button. Disabled while server is processing
  (`Posting…`). After server confirms queued, swap to a `Posted` pill or
  let the next 30s poll drop the card from the feed (matches reply
  behavior).
- Drop props: `onPostNow`, `onReschedule`, `forceEditing` keeps.
- Drop state: `hasOpenedX`.
- Drop UI: scheduled-time header pill (`ClockGlyph` + `formatScheduledTime`),
  the `· scheduled <time>` subtitle line, the `Tomorrow` text-action.
- Drop branches: `xIntentUrl` two-step flow, `isQueuedApi` queued-ETA
  branch, `formatQueuedEta`. The `xIntentUrl` branch in PostCard is dead
  after the refactor (X posts now queue via API; Reddit posts never
  populated `xIntentUrl` on the feed item).
- Reddit post flow stays approve-time handoff: user clicks `Post`,
  `/api/today/:id/approve` returns `browserHandoff: { intentUrl }`,
  client opens the Reddit submit URL in a new tab, card flips to
  `handed_off`. No PostCard code change for this path — it goes through
  the same `approve` mutation as X.

**`src/app/(app)/today/_components/reply-card.tsx`:**
- Drop the `Posting in 2m` ETA chip and `formatQueuedEta` helper.
- Drop the `onPostNow` queued-API branch.
- "Approve" button label stays.

## Section 5 — Tactical planner + downstream writers

Every site that writes `plan_items.scheduledAt` switches to
`dueDate` + `sortOrder`. Sites in scope:

- `src/lib/team-kickoff.ts` — initial week seed.
- `src/lib/team-daily-run.ts` — daily fan-out adds rows.
- `src/lib/re-plan.ts` — replan supersedes + reseeds.
- `src/skills/allocating-plan-items/*` (`schema.ts`, skill output).
- `src/skills/tactical-planner/*`.
- `src/tools/AddPlanItemTool`, `UpdatePlanItemTool`, `QueryPlanItemsTool`,
  `QueryStalledItemsTool`, `QueryLastWeekCompletionsTool`.

Sort-order convention: planner emits 0, 1, 2… per day in the order it
chooses. Replan resets values for the new horizon. No global uniqueness
constraint — the index handles ordering, ties broken by `id`.

Stalled query: `dueDate < today - <threshold-days>` (was
`scheduledAt < now - <threshold-ms>`). Threshold semantics shift from
"hours since scheduled time" to "days since due date" — close enough for
the sweeper's purpose (catches stuck items, not minute-precision stale).

`plan-execute-sweeper`, `stale-sweeper`, `daily-run-fanout`,
`engagement` processor: every `orderBy(scheduledAt)` /
`gte/lt(scheduledAt, ...)` becomes `(dueDate, sortOrder)`.

## Section 6 — API + hook cleanup

**`src/app/api/today/route.ts`:**
- Drop `scheduledFor` and `calendarScheduledAt` from the response DTO.
- Order by `(due_date, sort_order)`.

**`src/app/api/briefing/history/route.ts`:**
- Drop `scheduledFor` / `calendarScheduledAt` (already null in this
  route — just remove the fields).

**`src/hooks/use-today.ts`:**
- Drop `TodoItem.scheduledFor`, `TodoItem.calendarScheduledAt`,
  `TodoItem.queuedDelayMs`.
- Drop `TodoOptimisticStatus.pending_reschedule`, `.queued`.
- Drop `reschedule`, `postNow` mutations.
- Drop `formatDeferredMessage`, `ApproveResponseBody.deferred/reason/retryAfterMs/queued`.
- Drop the 202-deferred branch in `approve`.

**`src/app/(app)/today/today-content.tsx`:**
- Drop the `rawReschedule` plumbing.

## Section 7 — Tests + fixtures

**Delete:**
- `src/lib/__tests__/posting-pacer.test.ts`.
- `src/lib/__tests__/calendar-layout.test.ts`.
- `src/lib/__tests__/approve-dispatch.test.ts` deferred-branch cases
  (keep the file, trim the cases).
- Reschedule-related cases in `src/app/api/today/__tests__/route.test.ts`.

**Update:**
- `e2e/fixtures/db.ts` — seed rows now ship `dueDate` + `sortOrder`.
- `e2e/tests/team-chat.live-smoke.ts`, `e2e/tests/team-full-run.spec.ts`,
  `e2e/helpers/intercepts.ts` — adjust to new fixture shape.
- `scripts/seed-user.ts` — same.
- Every `__tests__/*.test.ts` that constructs a `plan_items` row.

**New:**
- One unit test on `/api/calendar` GET: seeds 3 rows across 2 days with
  out-of-order `sort_order`, asserts response orders correctly per day.

## Verification

- `pnpm tsc --noEmit` green.
- `pnpm test` green (vitest).
- `pnpm test:e2e` smoke: open `/today`, approve a post, see it drop from
  feed within 30s.
- Manual smoke: open `/calendar`, confirm week view shows day columns
  with stacked items, no time labels, no hour rail.
- Grep guard: `grep -rn "scheduledAt\|scheduledFor\|calendarScheduledAt\|delayMs\|posting-pacer\|reschedule\|formatQueuedEta\|hasOpenedX" src/` returns no app-code hits (matches in `enqueueEngagement` for engagement check-in delays are expected and stay).

## Out-of-scope follow-ups

- If we later want guardrails back, do it as an explicit `daily_post_log`
  table with hard-reject 429 — not a hidden pacer.
- If we later want a true calendar with times, reintroduce a separate
  `scheduled_publish_at` nullable column rather than overloading
  `due_date`.
