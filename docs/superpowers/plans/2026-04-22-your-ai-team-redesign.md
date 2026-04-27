# Implementation Plan: Your AI Team Redesign

**Plan path:** `docs/superpowers/plans/2026-04-22-your-ai-team-redesign.md`
**Date:** 2026-04-22
**Author:** pm (via team `ai-team-page-redesign`)
**Status:** Approved — option A confirmed by team-lead.

## 1. Scope

Rebuild `/team` as a three-column conversation-first workspace per `design_handoff_ai_team`: left rail (team roster + weekly budget), center (Claude-style chat with delegation cards + sticky composer), right rail (focused agent workspace + "Today's output"). The center conversation is wired to the existing `team_messages` / `/api/team/message` / SSE stack — this is a visual + layout rebuild, not a backend redesign. DB schema, agent roster, and run orchestration are unchanged; `/team/[memberId]` deep links survive.

## 2. Data-to-Design Mapping

Real `team_members.agentType` values (from `src/lib/team-presets.ts:DEFAULT_DISPLAY_NAMES`) map to the design's visual language as follows. New agent_types register by adding one entry to `agent-accent.ts`.

| agentType | Display role | Monogram | Color var / hex | Role code |
|---|---|---|---|---|
| `coordinator` | Chief of Staff | `C` (or first char of displayName) | `var(--sf-fg-1)` (#1d1d1f) | `CHIEF OF STAFF` |
| `growth-strategist` | Head of Growth | `G` | `var(--sf-success-ink)` (#248a3d) | `GROWTH` |
| `content-planner` | Head of Content | `P` (disambiguate vs coordinator) | `var(--sf-warning-ink)` (#c67a05) | `CONTENT` |
| `x-writer` | X Writer | `X` | `#5e5ce6` (indigo) | `X WRITER` |
| `reddit-writer` | Reddit Writer | `R` | `#ff9500` (orange) | `REDDIT WRITER` |
| `community-manager` | Community Manager | `M` | `#af52de` (purple) | `COMMUNITY` |

Monogram comes from the first character of `displayName` (or a supplied override when two roles would collide). Unknown agentTypes keep the existing hash-fallback in `avatarGradientForAgentType`, plus a neutral `var(--sf-fg-3)` dot and the agentType as the role code. The coordinator always sorts first.

## 3. Component Tree

All new files under `src/app/(app)/team/_components/`. LOC estimates are ceilings; split if any exceeds ~350.

### New files
| Path | Purpose | LOC |
|---|---|---|
| `agent-dot.tsx` | Monogram disc. Props: `color`, `initial`, `size` (18/24/28), `pulse?`, `active?`. | ~40 |
| `status-banner.tsx` | Blue `LIVE` pill + meta line + run id. Pulls activeRun + drafts-in-flight counts. | ~80 |
| `left-rail.tsx` | Sticky roster column. Section headers + iterates `agent-row` + renders `token-budget`. | ~180 |
| `agent-row.tsx` | Row in rail. Monogram, name, status dot, code, optional task-count pill, notes. | ~150 |
| `token-budget.tsx` | Weekly budget card: used/cap, segmented bar, legend. | ~90 |
| `conversation.tsx` | Client component. Wraps `useTeamEvents` with `teamId`. Renders user/lead bubbles chronologically. | ~200 |
| `user-message.tsx` | Blue right-aligned bubble. | ~30 |
| `lead-message.tsx` | Left-aligned row: monogram, name, ts, body + optional delegation card children. | ~60 |
| `delegation-card.tsx` | Grey inset card with dispatched-tasks list. Derives tasks from tool_call messages + team_tasks joins. | ~160 |
| `sticky-composer.tsx` | Fixed-bottom card with auto-grow textarea, attach stub, send button. Calls `/api/team/message`. | ~220 |
| `agent-workspace.tsx` | Right-rail card with agent-color gradient header + close button. Renders body as children. | ~120 |
| `agent-workspace-body.tsx` | Generic fallback body. Last 10 messages from the member + deep-link to `/team/[memberId]`. | ~180 |
| `todays-output.tsx` | 2×2 grid metric card. Stub values acceptable for v1 (`—` for voice match). | ~90 |

### Modified files
| Path | Change | LOC Δ |
|---|---|---|
| `page.tsx` | Rewritten server component: fetch team + members + activeRun + lastRun + team_messages + budget snapshot + roster. Renders the new 3-column shell. | ~180 → ~220 |
| `team-header.tsx` | Thinner header matching design: 28/600 title + meta `"1 Team Lead · N specialists · nothing ships without your approval"`. Activity/This-week copy relocates into `status-banner` + `token-budget`. | ~155 → ~60 |
| `agent-accent.ts` | Add `code: string`, `initial: string`, `colorHex: string` to `AgentAccent`; populate all 6 agent_types. Keep `solid`/`soft`/`ink`/`badgeVariant` for back-compat (member-card + `[memberId]/page.tsx`). Expose `colorHexForAgentType(agentType)`. | ~78 → ~150 |
| `layout.tsx` | Unchanged. | — |
| `[memberId]/page.tsx` | Unchanged (deep-link target). | — |

### Deleted
- `_components/member-card.tsx` — only `page.tsx` imports it; delete after grep confirms no other callers.

## 4. Token Audit

All tokens the design spec calls "existing" ARE defined in `src/app/globals.css`. See PM's full table in the conversation transcript; highlights:

- Reuse `--sf-bg-primary/secondary/tertiary`, `--sf-fg-1..4`, `--sf-accent`, `--sf-accent-light`, `--sf-success-ink/light`, `--sf-warning-ink/light`, `--sf-error-ink/light`, `--sf-link`, `--sf-border`, `--sf-border-subtle`, `--sf-font-mono/text`, `--sf-radius-md/lg/xl`, `--sf-shadow-card`, `--sf-ease-swift`, `--sf-dur-base/slow`, `--sf-space-sm..2xl`.
- Reuse `var(--animate-sf-fade-in)` and `var(--animate-sf-pulse)` (names differ from mock; functionally equivalent and reduced-motion-safe).
- **New (inline hex in `agent-accent.ts`, NOT new CSS vars):** `#5e5ce6` (x-writer indigo), `#ff9500` (reddit-writer orange), `#af52de` (community-manager purple).
- Composer radius `20` is a one-off literal (spec calls it out explicitly).

## 5. Server-Side Data Plan

In `page.tsx`, add these queries to the existing `Promise.all`:

```ts
// Recent conversation window (chronological ascending after reverse).
const recentMessages = await db
  .select({
    id: teamMessages.id,
    runId: teamMessages.runId,
    teamId: teamMessages.teamId,
    fromMemberId: teamMessages.fromMemberId,
    toMemberId: teamMessages.toMemberId,
    type: teamMessages.type,
    content: teamMessages.content,
    metadata: teamMessages.metadata,
    createdAt: teamMessages.createdAt,
  })
  .from(teamMessages)
  .where(eq(teamMessages.teamId, team.id))
  .orderBy(desc(teamMessages.createdAt))
  .limit(100);
// recentMessages.reverse() for chronological rendering

// Budget snapshot via existing helper.
import { getTeamBudgetSnapshot } from '@/lib/team-budget';
const budget = await getTeamBudgetSnapshot(team.id);

// Per-member week cost for token-budget segments.
const memberCosts = await db
  .select({
    memberId: teamTasks.memberId,
    sum: sql<string>`coalesce(sum(${teamTasks.costUsd}), 0)`.as('sum'),
  })
  .from(teamTasks)
  .innerJoin(teamRuns, eq(teamRuns.id, teamTasks.runId))
  .where(and(
    eq(teamRuns.teamId, team.id),
    gte(teamRuns.startedAt, startOfIsoWeek()),
  ))
  .groupBy(teamTasks.memberId);
```

**Budget displayed as dollars** (not tokens). Label the rail `WEEKLY BUDGET` with `$X.XX / $Y.YY` format. When `spentUsd === 0`, bar is empty and legend shows each member at 0%.

### Delegation card assembly (in `conversation.tsx`)
A pure reducer walks messages in order and stitches adjacent `agent_text` (lead) + `tool_call[Task]` events into a single `{kind:'lead', body, delegation}` shape before rendering. For `delegation` status/progress, join via `team_tasks`:
- `completed → progress 100`, `running → 50`, `pending → 0`
- `elapsed = completedAt - startedAt` formatted as `Xs` / `Xm`; `null` if unfinished
- Group all tool_calls within ±5s of the lead message into that lead's delegation array

No `setInterval` simulation. Progress changes when SSE feeds a status flip.

## 6. Interactions to Preserve

- SSE live updates via `useTeamEvents({ teamId, initialMessages })` (no `filter`).
- Enter submits, Shift+Enter newlines, ⌘+Enter fallback (muscle memory).
- `POST /api/team/message` unchanged; composer sends `{teamId, message}` without memberId (routes to coordinator).
- `/team/[memberId]` deep link still works; reachable from workspace body "Full activity log →" link.
- Agent-row click → sets active workspace (in-page, no navigation). Delegation task click → same.
- Responsive: `<1024px` collapses right rail below chat; `<768px` collapses left rail to horizontal agent-chip scroll and removes composer left-220 offset.

## 7. Out of Scope

- DB schema changes, new agent_types, new AGENT.md files.
- Bespoke per-agent workspace bodies (Nova/Ember/Sable/Arlo/Kit panels).
- Delegation progress simulation (the 800ms setInterval).
- "Send to Today" action inside workspace.
- Attach button functionality (renders disabled).
- Dark mode.
- Token-count display (we show dollars).

## 8. Acceptance Checklist

- [ ] `/team` renders a three-column grid at `≥1024px`: `280px / 1fr / 380px`, gap 20, horizontal padding 24, bottom padding 60. Status banner spans full width above.
- [ ] Left rail sticky `top: 72px`, max-height `calc(100vh - 88px)`, `#f5f5f7` bg, radius 12, padding 10. Token budget pinned to bottom.
- [ ] Every `team_members` row for the signed-in user's team renders an `<AgentRow>`; `coordinator` under "TEAM LEAD", rest under "SPECIALISTS · {N} SEATS".
- [ ] Conversation renders all `team_messages` in chronological order (limit 100 on server, live-extended via SSE). User prompts = blue right bubbles. Team Lead = left rows with `L` dot + timestamp. Delegation cards appear inline in lead messages where tool_calls exist.
- [ ] Sticky composer `position: fixed; left: 220px; right: 0; bottom: 0`, grid-aligned under center column. Enter submits, Shift+Enter newline. Send button disabled when empty.
- [ ] Posting calls `POST /api/team/message`; user bubble appears via SSE (dedupe by id).
- [ ] Right rail: agent-color gradient header, monogram, name, role code, subtitle, close ×. Body shows last 10 messages from that member. Empty state copy: "Select an agent on the left to open their workspace."
- [ ] Today's output 2×2 metric card below workspace.
- [ ] `/team/[memberId]` deep link still works via workspace body "Full activity log →".
- [ ] Keyboard nav visible. Reduced-motion respected.
- [ ] `pnpm tsc --noEmit` clean. No `any`. No `console.log`.

## 9. Risks & Open Questions

1. **Delegation stitching edge cases** — if messages arrive out-of-order over SSE, the ±5s window grouping may misfire. Mitigation: server-rendered initial window is the source of truth; SSE append-only adds new nodes.
2. **Progress without simulation** — "working" tasks sit at 50% until SSE flips them. Acceptable for v1.
3. **Multiple coordinators** — guard with earliest-createdAt wins; others render as specialists.
4. **Budget = 0** — render numbers anyway (`$0.00 / $5.00`) for consistency.
5. **Member-card deletion** — confirmed only `page.tsx` imports it; safe to delete.
6. **Workspace body placeholder** — generic last-10-messages body will feel thin until Phase F; acceptable for v1.

## 10. Implementation Order

Phase 1 (shell + tokens): extend `agent-accent.ts`; build `agent-dot.tsx`; gut + rewrite `page.tsx` to fetch new data and render the 3-column grid shell.

Phase 2 (left rail): `agent-row.tsx`, `token-budget.tsx`, `left-rail.tsx`. Wire status-banner + slimmer `team-header.tsx`.

Phase 3 (center conversation): `user-message.tsx`, `lead-message.tsx`, `conversation.tsx` with `useTeamEvents`, `delegation-card.tsx` + stitching reducer, `sticky-composer.tsx` wired to `/api/team/message`.

Phase 4 (right rail): `agent-workspace.tsx`, `agent-workspace-body.tsx`, `todays-output.tsx`. Active-member state lifted to a client-only slice in `page.tsx`.

Phase 5 (cleanup): delete `member-card.tsx`; responsive breakpoints (<1024, <768); manual SSE + deep-link + keyboard + reduced-motion test.

Each phase is independently mergeable.
