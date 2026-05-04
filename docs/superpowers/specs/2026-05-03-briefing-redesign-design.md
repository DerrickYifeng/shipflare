# Briefing — `/today` redesign + `/calendar` consolidation

**Date:** 2026-05-03
**Author:** Yifeng (PM/eng)
**Status:** DRAFT
**Branch:** dev

## Problem

`/today` currently feels like a chore list, not a founder's command surface. Two coupled symptoms:

1. **Vibe.** The page is a queue of approval cards. The implicit message is "here are tasks, do them." Founders running ShipFlare are paying for an AI team — `/today` should feel like checking on team output, not picking up tickets.
2. **Post-kickoff confusion (concrete failure mode).** Kickoff allocates plan_items across the week. Drafters fire shortly before each `scheduledAt`. When kickoff allocates, e.g., a reply slot for Wed and a post for Thu, Monday's `/today` looks empty — there are no `drafted | ready_for_review | approved` items yet, and `planned`-state plan_items are filtered out of `/api/today`. Founders see "today: nothing" and conclude the system is broken.

Both symptoms have the same root: `/today` is a queue, not a briefing. The reframe and the bug fix collapse to one design.

## Decision

Merge `/today` and `/calendar` into a new `/briefing` route with two tabs. Rename the parent surface from "Today" to "Briefing" so the framing carries the boss / morning-exec-read vibe.

```
/briefing            → Today tab (default) — approval inbox
/briefing/plan       → Plan tab — week grid (current /calendar)
```

`/today` 301s to `/briefing`. `/calendar` 301s to `/briefing/plan` (preserving `?weekStart=`).

The kickoff edge case is fixed at the IA level: planned-but-not-drafted items have a real home (Plan tab), and the always-present `BriefingHeader` says "This week · 6 more queued" so the founder sees the team's commitment without leaving the Today tab.

## Premises (agreed during brainstorming)

1. Most of the day, agents are idle (scheduled, not always-on). Any "live activity feed" zone would be empty 95% of the time. **The page must not depend on motion to feel alive.**
2. A team-roster sidebar (one line per agent: state · last action · next action) was considered and rejected — adds surface without driving a decision.
3. `/calendar` already does the week-grid job at production fidelity. Don't rebuild it; reuse it under the Plan tab.
4. Each rule lives in one place: parent shell owns nav + header copy; tabs own their own data; `/api/calendar` and `/api/today` keep their existing contracts. The only new endpoint is `/api/briefing/summary`.
5. Posts and replies stay in **separate sections** inside the Today tab (matches current `/today`). They are not interleaved chronologically.

## Approaches considered

### Approach A — Soft merge (link only) [REJECTED]

Drop the planned "this week" zone from `/today` and just add a `view in calendar →` link in the header. Keep `/today` and `/calendar` as separate routes.

- Cheapest, ships fastest.
- Doesn't fix the vibe — `/today` is still framed as a task list.
- Two pages still feel like two products.

### Approach B — Tab merge [SELECTED]

Single `/briefing` route with Today and Plan tabs. Both tabs deep-linkable. Reuse `/calendar`'s mature week grid as-is. Rename the parent to `Briefing` so the wrapper carries the boss frame.

- One mental model, one nav entry.
- No `/calendar` rewrite — Plan tab embeds existing component.
- New `BriefingHeader` is the only genuinely-new component; everything else is file moves + small touch-ups.

### Approach C — Calendar absorbs inbox [REJECTED]

Delete `/today`. `/calendar` becomes the only home. Today's column shows expanded approval cards inline.

- Truest consolidation.
- Approval card UX in a calendar cell is hard (rich body, edit mode, media).
- Mobile UX of approving inside a calendar grid is clumsy.
- Drafts-table reply rows don't fit the plan_item-shaped grid cleanly.

## Recommended approach: B — Tab merge with rename

Page name: **Briefing**. Tabs: **Today** (inbox) / **Plan** (calendar).

## Detailed design

### §1 · Architecture & routing

**New shell.** `/briefing` becomes the parent route. It owns tab state and a single `BriefingHeader`.

- `/briefing` → Today tab (default)
- `/briefing/plan` → Plan tab
- `?weekStart=YYYY-MM-DD` works on Plan tab (mirrors `/api/calendar` contract)

**Redirects (301-permanent, configured in `next.config.ts`).**

- `/today` → `/briefing`
- `/calendar` → `/briefing/plan` (preserving `?weekStart`)

Old paths remain in `next.config.ts` redirects for one release cycle, then removed once analytics confirm zero direct traffic.

**File layout.**

```
src/app/(app)/briefing/
  layout.tsx                    ← tab nav + BriefingHeader
  page.tsx                      ← Today tab server shell
  plan/page.tsx                 ← Plan tab server shell
  _components/
    briefing-header.tsx         ← NEW: yesterday/today/this-week summary line
    today-tab.tsx               ← extracted from today/today-content.tsx
    plan-tab.tsx                ← extracted from calendar/calendar-content.tsx
    tab-nav.tsx                 ← shared tab control
```

**Existing files moved (not rewritten).**

- `today/today-content.tsx` → split: meta-line removed (BriefingHeader owns it), rest becomes `today-tab.tsx`
- `today/_components/*` → `briefing/_components/today/*` (all card components, source filter, reply slot card)
- `calendar/calendar-content.tsx` → renamed `plan-tab.tsx` (no behavioral changes)
- `calendar/_components` (if any) → `briefing/_components/plan/*`

**Removed surfaces.**

- `TodayWelcomeRibbon` → folded into `BriefingHeader`'s day-1 hero copy. The 24h `localStorage` dismiss key (`sf:onboarded-ribbon-dismissed`) is read once during the migration window for backward compat, then becomes irrelevant (the day-1 state is server-derived from `products.onboardingCompletedAt`).
- The bottom-of-page "this week" zone that earlier sketches included → never gets built; the Plan tab carries that load.

**Kept.**

- `TacticalProgressCard` → renders inside the Today tab when (and only when) tactical work is actively in-flight (current behavior). Long-term we may fold its signal into `BriefingHeader` copy, but that's out of scope for this spec.
- `j/k/a/e/s/?` keyboard shortcuts (Today tab)
- `SourceFilterRail` (Today tab)
- `ReplySlotCard` (Today tab)
- `CompletionState` celebration block (Today tab, when fully caught up)

### §2 · `BriefingHeader` — always-populated top line

Sits above the tabs in `briefing/layout.tsx`. Replaces the current "{N} to review · {N} shipped today · last run {t}" meta line.

**Steady-state copy (3 lines):**

```
Today · 1 awaiting · 1 shipped
This week · 6 more queued
Yesterday · shipped 2, skipped 1
```

**Day-1 state** (within 24h of `products.onboardingCompletedAt`):

```
Day 1 · plan locked
Your team committed to 2 posts + 1 reply session this week.
```

Auto-reverts to steady-state copy after 24h. Replaces `TodayWelcomeRibbon`.

**All-clear state** (`awaiting=0 && totalQueued=0 && shipped>=1`):

```
All clear · 1 shipped today
Discovery runs again ~6h.
```

**Data source.** New endpoint `GET /api/briefing/summary`:

```ts
interface BriefingSummary {
  today: { awaiting: number; shipped: number; skipped: number };
  yesterday: { shipped: number; skipped: number };
  thisWeek: { totalQueued: number; totalShipped: number };
  isDay1: boolean;                  // within 24h of onboardingCompletedAt
  nextDiscoveryAt: string | null;   // ISO; for the all-clear copy
}
```

Backed by a single `plan_items` aggregate query (extension of the `planStats` query already in `/api/today`). Server-rendered for initial paint (no flash); SWR-revalidated on the client at 60s interval, matching `/api/calendar`.

**Why this fixes the kickoff confusion.** Even with 0 cards on the Today tab, the founder sees `This week · 6 more queued` in the header and `Day 1 · plan locked` underneath. The team's commitment is visible without scrolling, switching tabs, or seeing an empty-state lecture. One click to the Plan tab shows the full breakdown.

### §3 · Today tab — what stays, what tightens

The tab body is `today-content.tsx` minus the top meta line (BriefingHeader owns it). Three concrete changes inside:

**(a) Per-card byline.** Every approval card gets a one-line provenance under the title.

- Posts: `Drafted by your writer · scheduled Tue 10am`
- Replies: `Your scout flagged this · r/SaaS · score 8.4`

The agent-role labels (`writer`, `scout`) are **derived from `plan_items.kind` and the row source**, not stored — content_post/content_reply rows imply the writer; the discovery side of a reply implies the scout. The dynamic parts (`scheduledAt`, `threads.community`, `drafts.confidenceScore`) are all populated today. No schema change; no new persisted field. One small render addition per card component. This is the "your team did this" signal that converts queue → reviewed-by-the-boss.

**(b) Empty state collapses to one line.** Today's centered hero ("All caught up on replies. Discovery runs daily.") is replaced with a thin one-liner inside the tab body: `Nothing on you right now. Next drafts ~10min before scheduled slots.` `BriefingHeader` carries the celebration job; the tab body shouldn't double it.

**(c) Posts and replies stay in separate sections.** Matches current `/today`. The "Replies" and "Scheduled posts" `<Section>` headers are preserved.

**Backend.** `/api/today` keeps its current contract. The `planned`-state filter stays — those items belong to the Plan tab, not the Today tab.

### §4 · Plan tab — `/calendar` reused as-is

The Plan tab renders `<PlanTab />` (renamed `calendar-content.tsx`) with zero behavioral changes. `/api/calendar` is unchanged. Week navigation (`?weekStart=`), hour-positioned cards, collapsed bands, mobile fallback, scroll-to-now — all preserved.

**Two small touches:**

1. `BriefingHeader` always renders above the Plan tab too — same component, same data. Day-1 hero copy works identically here.
2. Empty future days get a subtle hint when they have `planned`-state items: `Drafting starts ~10min before each slot.` Tiny `calendar-layout.ts` consumer tweak, not a rewrite.

**Not changing in `/calendar`:**

- Collapsed-bands hour grid algorithm
- `/api/calendar` query
- Week-navigation prev/next buttons
- Mobile stacked-list fallback
- Event positioning math in `calendar-layout.ts`

Future calendar evolutions (drag-to-reschedule, multi-week view) are separate specs.

### §5 · Data flow & error handling

**Server-rendered initial paint.** `/briefing/page.tsx` and `/briefing/plan/page.tsx` both fetch the BriefingHeader summary server-side and pass it as a prop. No client-side flash. Both pages keep their existing onboarding gate (`if (!product) redirect('/onboarding')`).

**Client revalidation:**

- `BriefingHeader` → SWR key `/api/briefing/summary`, `refreshInterval: 60_000`
- Today tab → existing `useToday()` against `/api/today` (unchanged)
- Plan tab → existing SWR against `/api/calendar?weekStart=` (unchanged)

All three SWR caches are independent. Tab switch is purely client-side; the inactive tab's component unmounts but its SWR cache survives, so coming back is instant.

**Error handling:**

| Layer | Failure | Behavior |
|---|---|---|
| `/api/briefing/summary` 5xx | header can't load | header collapses to a single neutral line: `Today` (no counts). Tabs still work. |
| `/api/today` 5xx | inbox can't load | existing `useToday()` error path (toast + retry) — unchanged |
| `/api/calendar` 5xx | week grid can't load | existing `<EmptyState>` "Calendar fetch failed" — unchanged |
| Tab route 404 (e.g. typo `/briefing/typo`) | Next.js default 404 | acceptable; nothing custom |
| Permanent redirects from `/today` and `/calendar` | `next.config.ts` `redirects()` | static redirects, never fail at the app layer |

**Onboarding gate.** Both `/briefing` pages run the same `auth + product` check that `/today` and `/calendar` do today. Auth failures bounce to `/`. No-product bounces to `/onboarding`.

**Day-1 hero state truth.** `BriefingHeader.isDay1` is computed server-side from `products.onboardingCompletedAt` (24h window). No `localStorage` for this — server-side time is more honest and survives device switches. The user's manual dismiss of the *old* welcome ribbon stays in `localStorage` for the migration window so existing dismissals carry over for 24h, then becomes a moot point.

### §6 · Testing

**Unit tests (Vitest, isolatedModules):**

| File | What it tests |
|---|---|
| `briefing-header.test.tsx` | renders three lines for steady state; renders day-1 hero when `isDay1=true`; renders all-clear copy when `awaiting=0 && shipped>0 && totalQueued=0`; collapses to single line on null summary |
| `api/briefing/summary/route.test.ts` | aggregates yesterday/today/this-week buckets correctly; computes `isDay1` from `onboardingCompletedAt` 24h window; handles user with no plan_items (returns zeros, not 500); rejects unauthed |
| `tab-nav.test.tsx` | active tab matches URL pathname; clicking a tab pushes the right URL; preserves `?weekStart` query when crossing into Plan tab |
| `today-tab.test.tsx` | byline renders for plan-item posts (role label derived from `plan_items.kind`, schedule from `plan_items.scheduledAt`); byline renders for reply drafts (`threads.community + drafts.confidenceScore`); empty state is the new one-liner, not the old hero |

These are pure render/aggregation tests — no live DB. Existing `today-content.tsx` tests get moved/renamed to `today-tab.test.tsx`; calendar tests stay where they are.

**Integration tests:**

| File | What it tests |
|---|---|
| `briefing-routing.test.ts` | `/today` 301s to `/briefing`; `/calendar` 301s to `/briefing/plan`; `/calendar?weekStart=2026-05-04` preserves the query through the redirect |
| `briefing-summary.integration.test.ts` | seeds plan_items + drafts + threads → calls `/api/briefing/summary` → asserts buckets match |

**Real-browser smoke (Playwright `live-smoke` project):**

`tests/live-smoke/briefing-tabs.spec.ts`:

- sign in (uses `.auth/founder.json` storageState)
- visit `/briefing` → header has three lines, "Today" tab is active
- click Plan tab → URL is `/briefing/plan`, calendar grid renders
- visit `/today` directly → 301 to `/briefing`
- visit `/calendar?weekStart=2026-05-04` directly → 301 to `/briefing/plan?weekStart=2026-05-04`

Catches the redirect chain working end-to-end with real Next.js middleware + auth — the class of bug that unit tests miss.

**Type-check + build gate.** `pnpm tsc --noEmit` + `pnpm build` both stay green. Vitest passing is necessary but not sufficient — the build gate is the canonical signal.

**Manual QA checklist:**

- Day-1 founder flow: complete onboarding → land on `/briefing` → header reads "Day 1 · plan locked"
- Old bookmark flow: `/today` → bounces to `/briefing` (same for `/calendar` → `/briefing/plan`)
- Empty Today + non-empty Plan flow: kickoff allocates Wed/Thu items only → Monday's `/briefing` shows 0 awaiting cards but `This week · 6 more queued` in header → Plan tab shows Wed/Thu populated. (This is the user-reported failure mode; it must look obviously fine.)

## Open questions

None blocking implementation. Future work tracked separately:

- Drag-to-reschedule on Plan tab
- Multi-week Plan view
- Folding `TacticalProgressCard` signal into `BriefingHeader` copy

## Distribution / rollout

This is a web-app surface change, not a packaged deliverable. Rollout via standard merge-to-main + Vercel deploy. No feature flag — the redirects make the migration atomic from the user's perspective.

**Old route cleanup:** keep `/today` and `/calendar` redirect entries in `next.config.ts` for one full release cycle (~2 weeks), then remove. Delete `src/app/(app)/today/` and `src/app/(app)/calendar/` directories at the same time the redirects are removed.

## Dependencies

- `next.config.ts` — add `redirects()` block
- New endpoint: `src/app/api/briefing/summary/route.ts`
- Schema: no DB changes
- Workers: no changes

## Success criteria

1. Founder completes kickoff → lands on `/briefing` → header reads "Day 1 · plan locked · Your team committed to N posts + M reply sessions this week" → reaction is "great, let me see the plan" not "where did everything go."
2. Bookmarks of `/today` and `/calendar` continue working (301 redirects).
3. Old `today-content.tsx` and `calendar-content.tsx` test suites continue passing after the file move + extraction.
4. Live-smoke spec passes against the real Vercel preview URL.
5. `pnpm tsc --noEmit` + `pnpm build` green.

## Distribution Plan

In-tree web app — no separate distribution channel. Deploys to production via existing CI on merge to `main`.
