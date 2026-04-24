# Implementation Plan: Team Session History

**Plan path:** `docs/superpowers/plans/2026-04-22-team-session-history.md`
**Date:** 2026-04-22
**Author:** pm (via team `team-session-history`)
**Status:** Approved — option (1) picked by team-lead.

## 1. Scope

Three changes to `/team`: (a) hide onboarding runs from the conversation column, (b) add a Claude-style session list inside the existing LeftRail, (c) add a "+ New session" affordance that starts a fresh team_run when none is active (disabled with tooltip while a run is running).

## 2. Hide onboarding

Edit `src/app/(app)/team/page.tsx` — the `rawMessages` SELECT, the `runIds`→`runRows` query, and `taskRows`.

Approach: exclude onboarding runs at the DB boundary. LEFT JOIN `team_runs` and filter `trigger != 'onboarding'`, while letting orphan messages (`run_id IS NULL`) through.

```ts
.from(teamMessages)
.leftJoin(teamRuns, eq(teamRuns.id, teamMessages.runId))
.where(
  and(
    eq(teamMessages.teamId, team.id),
    or(isNull(teamMessages.runId), ne(teamRuns.trigger, 'onboarding')),
  ),
)
.orderBy(desc(teamMessages.createdAt))
.limit(INITIAL_MESSAGE_WINDOW);
```

Import `or`, `isNull`, `ne` from `drizzle-orm`. Apply same filter to `taskRows` (exclude onboarding tasks from "Today's Output"). Keep `memberCostRows` unfiltered so budget counters still reflect real cost.

Client safety net: in `conversation-reducer.ts groupByRun`, defensively drop groups whose `run.trigger === 'onboarding'`.

## 3. Session history UI

Placement: inside `LeftRail`, new section between "Specialists" and `TokenBudget`.

Row anatomy (~44px):
- Status dot (reuse `toneColor` palette from SessionDivider)
- Trigger label (shared from extracted `session-meta.ts`)
- Smart timestamp (extracted)
- Goal preview truncated to ~48 chars, `var(--sf-fg-3)`

Header: "SESSIONS" label + count badge.

First row: `ALL` (clears filter, shows all non-onboarding sessions).

Scroll: `max-height: 264px` (6 rows × 44). Overflow → internal scroll.

Empty state: muted "No past sessions" row.

Server query:
```ts
db.select({ id, trigger, goal, status, startedAt, completedAt, totalTurns })
  .from(teamRuns)
  .where(and(eq(teamRuns.teamId, team.id), ne(teamRuns.trigger, 'onboarding')))
  .orderBy(desc(teamRuns.startedAt))
  .limit(20);
```

## 4. New session — Option (1) picked

Button above the sessions list, labeled `+ New session`.

**Enabled** (no active run) → POSTs to `/api/team/run` with `{ teamId, trigger: 'manual', goal: '' }`.

Small route diff in `src/app/api/team/run/route.ts` (~6 lines): when `trigger === 'manual'` and `goal === ''`, substitute the neutral template from `deriveGoalFromTrigger`'s default branch ("Review team state and propose next actions for ${productName}.").

**Disabled** (run active) → `aria-disabled="true"` + `title="Wait for the current session to finish — or send a follow-up in the composer."`

After creation: SSE flushes new rows; TeamDesk auto-selects `selectedRunId = response.runId`.

Why (1) over (2)/(3): `idx_team_runs_one_running_per_team` partial unique index forbids concurrent runs. (2) cancel-current is risky. (3) queue-pending needs worker dequeue logic. (1) is zero real backend change.

## 5. Component tree delta

**New files:**
- `src/app/(app)/team/_components/session-list.tsx` (~150 LOC)
- `src/app/(app)/team/_components/session-row.tsx` (~90 LOC)
- `src/app/(app)/team/_components/session-meta.ts` (~50 LOC — shared `TRIGGER_LABELS`, `formatStart`, `statusTone`, `toneColor` extracted from `session-divider.tsx`)
- `src/app/(app)/team/_components/use-new-session.ts` (~40 LOC — hook wrapping POST `/api/team/run`)

**Modified:**
- `src/app/(app)/team/page.tsx` — onboarding filter + fetch 20 recent sessions (~40 LOC Δ)
- `src/app/(app)/team/_components/team-desk.tsx` — `sessions` prop + `selectedRunId` state (~25 LOC Δ)
- `src/app/(app)/team/_components/left-rail.tsx` — render SessionList + New-session button (~30 LOC Δ)
- `src/app/(app)/team/_components/conversation.tsx` — filter groups by selectedRunId (~8 LOC Δ)
- `src/app/(app)/team/_components/session-divider.tsx` — use extracted helpers (~60 LOC removed)
- `src/app/(app)/team/_components/conversation-reducer.ts` — defensive onboarding filter in groupByRun (~4 LOC)
- `src/app/api/team/run/route.ts` — allow manual + empty goal (~6 LOC)

All files stay <300 LOC; nothing near the 800 cap.

## 6. State shape

```ts
interface SessionMeta {
  id: string;
  trigger: string;
  goal: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'pending';
  startedAt: string;
  completedAt: string | null;
  totalTurns: number;
}
```

TeamDesk:
- Prop: `sessions: readonly SessionMeta[]`
- State: `selectedRunId: string | null` (null = ALL; default = `activeRunId ?? null`)
- Handlers: `handleSelectSession(runId | null)`, `handleNewSession()`

LeftRail props add: `sessions`, `selectedRunId`, `onSelectSession`, `onNewSession`, `canCreateSession`, `creatingSession`.

Conversation prop adds: `selectedRunId`. Filter: `groups.filter(g => selectedRunId === null || g.runId === selectedRunId)`.

## 7. Acceptance checklist

- [ ] Onboarding bubbles don't appear in `/team` conversation after onboarding completes.
- [ ] "Today's Output" counters exclude onboarding tasks.
- [ ] LeftRail SESSIONS section shows up to 20 recent non-onboarding sessions, newest first.
- [ ] Clicking a session row filters the conversation; clicking ALL restores full view.
- [ ] `+ New session` enabled when no run running; click POSTs `/api/team/run` with `manual` trigger, selects the new run.
- [ ] `+ New session` disabled while a run is running; tooltip explains why.
- [ ] SSE-delivered messages for the selected session append live; other runs' messages don't shift scroll.
- [ ] Empty team shows "No past sessions" placeholder.
- [ ] `/team/[memberId]` deep link unaffected.
- [ ] `pnpm tsc --noEmit` exit 0.

## 8. Risks

1. Stale tab: user clicks `+ New session` but a run started elsewhere. Route returns `alreadyRunning: true` + existing runId → client gracefully selects it.
2. Session list is server-rendered; a run completing right after load will show as `running` until SSE status update.
3. No UI to inspect onboarding history (debug via SQL).
4. Refactor of session-divider.tsx helpers into session-meta.ts touches adjacent code; verify tsc.

## 9. Out of scope

- Deleting/renaming sessions
- Pagination beyond 20
- Onboarding history inspector
- Compare view
- Search/filter within sessions
- Cancelling a running session from the list
