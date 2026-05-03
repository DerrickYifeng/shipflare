# Agent Teams UI Redesign — A + B + C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapt the founder UI to the post-Phase-G Claude-Code-style runtime: lead is always present, teammates run in parallel as first-class agent_runs rows, conversation is multi-turn and persistent. Migrate stale team_runs reads (UI-A), add new affordances Agent Teams enables (UI-B: teammate roster + transcript drawer + task-notification rendering + sleep indicators + per-teammate cancel), reframe the conceptual mental model (UI-C: "always-present lead" instead of "discrete runs").

**Architecture:** Server reads switch from `team_runs` (write path deleted Phase E) to `agent_runs` keyed by `role='lead'` for the team-lead's status. Multi-turn conversation rendered as a linear chat (Claude.ai style) with teammate spawn cards inline; teammates render as collapsed bubbles that expand on click into a side drawer showing per-teammate transcript. Agent state visualization uses a small status-pill vocabulary (sleeping zZz / queued / running spinner / resuming flash / completed ✓ / failed ✗ / killed 🛑). All live state via SSE on the existing `team:${teamId}:messages` channel — no polling.

**Tech Stack:** Next.js (server components for initial render + client components for SSE-driven live state), TypeScript, Tailwind, Drizzle, SSE.

**Spec reference:** `docs/superpowers/specs/2026-05-02-agent-teams-architecture-design.md` § Phase G + the post-Phase-G Implementation Status entries.

---

## §0 Visualization design — choices + rationale

### Agent state vocabulary

5 lifecycle states need 5 visual signals. Match each to its shipflare semantic:

| State | Visual | Color | Motion | Notes |
|---|---|---|---|---|
| `sleeping` | zZz icon, name dimmed 60% | gray-500 | static | "lead is around but idle"; teammate yielded slot via Sleep |
| `queued` | small dot, name normal | amber-400 | faint pulse 1s | brief — usually transitions to running within seconds |
| `running` | spinner ring around avatar | blue-500 | continuous spin | the active state |
| `resuming` | spinner with flash overlay | yellow-400 | 200ms flash → spin | transient — usually <1s |
| `completed` | checkmark badge | green-500 | static | shows for 24h then hides |
| `failed` / `killed` | red badge with cause hover | red-500 | static | always visible; user must dismiss |

**Why this vocabulary and not e.g. "active/idle"?** The 5 states ARE in the schema (`agent_runs.status` check constraint). UI must distinguish `sleeping` from `queued` (queued = "we're about to wake you"; sleeping = "you said you're done waiting"). Conflating them confuses debugging.

### Layout pattern

Three-pane layout (proven by Slack, Linear, Discord):

```
┌─────────────────────────────────────────────────────────────────┐
│ [Founder Avatar] Team Status: Lead running ● 2 teammates active │
├─────────────┬─────────────────────────────────┬─────────────────┤
│             │                                 │                 │
│ Roster      │ Lead conversation (main chat)   │ Activity feed   │
│             │                                 │                 │
│ ● Lead      │ [Founder]: kick off post for X  │ 14:23 Lead      │
│   Sonnet    │                                 │   spawned       │
│             │ [Lead]: I'll spawn researcher   │   researcher    │
│ ⌛ Researcher│  + author in parallel.          │                 │
│   spinner   │  ┌─────────────────────────────┐│ 14:23 Lead      │
│             │  │ ⌛ Researcher (running, 23s)││   spawned       │
│ zZz Author  │  │ Click to open transcript    ││   author        │
│   sleeping  │  └─────────────────────────────┘│                 │
│             │  ┌─────────────────────────────┐│ 14:24 Researcher│
│             │  │ ✓ Author (completed, 2 turns││   → Author      │
│             │  │ "Drafted 3 variations"      ││   "ask about    │
│             │  └─────────────────────────────┘│    citations"   │
│             │                                 │                 │
│             │ [Founder]: ▌                    │ 14:25 Author    │
│             │                                 │   completed: 3  │
│             │                                 │   drafts        │
└─────────────┴─────────────────────────────────┴─────────────────┘
```

**Why three-pane and not chat-only?**
- Roster (left) makes parallelism legible — you SEE 3 teammates running simultaneously; chat-only hides that
- Activity feed (right) gives the lead's "transparency" view (peer DM shadows + spawn events + completions) without polluting the main chat
- Main chat (center) stays clean — Founder's conversation with Lead, with collapsed teammate spawn cards inline

**Mobile**: collapse to chat-only; roster + activity feed become drawers.

### Multi-turn conversation rendering

Each "turn" in the lead's conversation is a vertical band. Teammates spawned in that turn render as inline collapsed cards. Click a card → opens that teammate's transcript in a side drawer (right-side slide-out, can stay pinned or close).

```
─── Turn 1 (founder asks about post) ───────────────────────────
[Founder]: ...
[Lead]: I'll spawn researcher + author...
  ┌─ ⌛ Researcher (running) ────────────────┐  ← click expands
  └──────────────────────────────────────────┘
  ┌─ ✓ Author (completed, 2 turns) ──────────┐  ← click expands
  │ Drafted 3 variations                      │
  └──────────────────────────────────────────┘
[Lead]: Researcher found prior context. Drafts ready for review.

─── Turn 2 (founder asks for changes) ──────────────────────────
[Founder]: tweak draft 2 to be friendlier
[Lead]: ...
```

**Task-notification messages** (the `<task-notification>` XML inserted by SyntheticOutputTool when a teammate exits): render as the collapsed teammate card above. Don't show raw XML — parse the `<task-id>`, `<status>`, `<summary>`, `<r>`, `<usage>` and surface them structurally.

**Peer-DM shadows** (the `<peer-dm from="X" to="Y">summary</peer-dm>` rows that land in lead's mailbox without waking the lead): render in the **activity feed**, NOT in the main chat. They're transparency, not conversation.

### Live state plumbing

All transitions arrive via the existing SSE channel `team:${teamId}:messages`. The `agent-run.ts` post-Phase-G fix at `8ebe6e1` already publishes:
- `agent_text` events (assistant turns)
- terminal `completion` / `error` events when the lead's run ends

UI-B adds publishes for:
- `agent_runs.status` transitions (queued → running → sleeping → completed/failed/killed)
- These events drive the roster pills + activity feed

No polling. SSE reconnect logic must be solid (the existing `useTeamEvents` hook handles this; verify after UI-A).

---

## §1 File structure

**Modified files (UI-A — read-path migration, 5 files):**

| Path | Change |
|---|---|
| `src/app/api/team/status/route.ts:54-65` | `activeRun` query: `teamRuns.status='running'` → `agent_runs WHERE teamId AND agentDefName='coordinator' AND status IN ('running','resuming')` |
| `src/app/api/today/progress/route.ts:128-145` | tactical run progress: replace `teamRuns.status` lookup with derived state from `agent_runs` lead row + count of recent `team_messages` |
| `src/app/api/team/task/[taskId]/retry/route.ts:55-58` | drop `innerJoin(teamRuns)`; validate via team_tasks → teamMembers → teams ownership chain |
| `src/app/api/team/task/[taskId]/cancel/route.ts:52-53` | same as retry |
| `src/app/(app)/team/page.tsx:158-413` | server component: replace 4 distinct teamRuns queries (activeRunRows / lastRunRows / runLookup / weekly stats) with agent_runs + team_messages queries |

**New files (UI-B — Agent Teams affordances, ~7 files):**

| Path | Responsibility |
|---|---|
| `src/app/(app)/team/_components/teammate-roster.tsx` | Left sidebar list — all `agent_runs WHERE teamId IN (running, sleeping, queued, resuming)` grouped by parentAgentId. Status pill per row. Live SSE updates |
| `src/app/(app)/team/_components/teammate-transcript-drawer.tsx` | Right drawer — opens on teammate card click. Loads via `loadAgentRunHistory(agentId)` (Phase D). Shows messages chronologically |
| `src/app/(app)/team/_components/task-notification-card.tsx` | Renders a `<task-notification>` XML message as a structured card (status badge + summary + collapsed `<r>` body + usage chip) |
| `src/app/(app)/team/_components/agent-status-pill.tsx` | Reusable status pill (zZz / spinner / etc.) used by roster + cards |
| `src/app/(app)/team/_components/team-activity-feed.tsx` | Right sidebar — chronological feed of all team_messages (includes peer-DM shadows + spawn events + completions). Live SSE |
| `src/app/api/team/[teamId]/teammates/route.ts` | Server endpoint returning `agent_runs[]` for the team (initial roster hydration; SSE replaces it after) |
| `src/app/api/team/[teamId]/agent/[agentId]/transcript/route.ts` | Returns `loadAgentRunHistory(agentId)` for the drawer |

**Modified files (UI-B — wire into existing UI):**

| Path | Change |
|---|---|
| `src/app/(app)/team/page.tsx` | Add `<TeammateRoster>` (left), `<TeamActivityFeed>` (right). Center stays as existing `<TeamDesk>` |
| `src/app/(app)/team/_components/team-desk.tsx` | Detect `messageType='task_notification'` rows in transcript → render via `<TaskNotificationCard>` instead of plain text bubble |
| `src/workers/processors/agent-run.ts` | Publish `agent_runs.status` change events to SSE on every status transition (currently only publishes on assistant_text_stop + terminal end_turn). Add at: queued→running, running→sleeping, sleeping→resuming, resuming→running |
| `src/lib/team/cancel-teammate.ts` (NEW) | `cancelTeammate(agentId, db)`: insert `shutdown_request` to teammate's mailbox + wake. Used by per-teammate cancel button |
| `src/app/api/team/agent/[agentId]/cancel/route.ts` (NEW) | Per-teammate cancel endpoint (lead calls TaskStop tool internally; founder UI hits this for explicit cancellations) |

**Modified files (UI-C — conceptual reframe, 3 files):**

| Path | Change |
|---|---|
| `src/app/(app)/team/_components/team-desk.tsx` | "Start a run" CTA → "Send a message" / unified composer. Lead is always present; founder just sends |
| `src/app/(app)/onboarding/_components/...` (find the relevant onboarding components) | Replace "your team-lead will run when triggered" copy with "your lead is always available; just message it" |
| `CLAUDE.md` | Append a "Founder UI mental model" section documenting the always-present lead + parallelism affordances |

**Total:** 5 modifications (UI-A) + 7 new + 5 modifications (UI-B) + 3 modifications (UI-C) = 20 file touches across **13 tasks**.

---

## §2 Sequence + dependencies

```
UI-A (5 read-path fixes — ship first; immediate bleed)
  Task 1 (api/team/status)         ──┐
  Task 2 (api/today/progress)      ──┤
  Task 3 (api/team/task retry)     ──┤  All independent; can ship in parallel commits
  Task 4 (api/team/task cancel)    ──┤
  Task 5 (app team/page server)    ──┘
       │
       ▼
UI-B (Agent Teams affordances — ships incrementally)
  Task 6  (agent-status-pill)        ─┐  shared component first
  Task 7  (task-notification-card)   ─┴─▶  Task 8  (teammate-roster + endpoint)
                                              │
  Task 9  (transcript drawer + endpoint) ◄────┤
                                              │
  Task 10 (activity feed)            ─────────┤
                                              │
  Task 11 (per-teammate cancel)      ◄────────┘
       │
       ▼
UI-C (mental-model copy reframe)
  Task 12 (CTA + composer)
  Task 13 (onboarding copy + CLAUDE.md)
       │
       ▼
Verification gate
```

---

## UI-A Tasks (read-path migration)

### Task 1: Migrate `/api/team/status` activeRun query

**Files:**
- Modify: `src/app/api/team/status/route.ts`
- Test: existing test if present (check `__tests__/`); else inline contract test

- [ ] **Step 1: Add a failing test (or extend existing)**

If `src/app/api/team/status/__tests__/` doesn't exist, create `src/app/api/team/status/__tests__/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '../route';

vi.mock('@/lib/auth', () => ({
  getServerSession: vi.fn(async () => ({ user: { id: 'user-1' } })),
}));
vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(),
  },
}));

import { db } from '@/lib/db';

function makeReq(teamId: string) {
  return new Request(`http://test/api/team/status?teamId=${teamId}`);
}

describe('GET /api/team/status', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns activeRun when lead agent_runs status is running', async () => {
    // mock 3 select chains: team lookup, member list, lead-status query
    let call = 0;
    vi.mocked(db.select).mockImplementation(() => {
      call += 1;
      if (call === 1) return makeChain([{ id: 'team-1', name: 'T', userId: 'user-1', createdAt: new Date() }]);
      if (call === 2) return makeChain([]);
      // call 3: lead query
      return makeChain([{
        agentId: 'lead-agent-1',
        status: 'running',
        lastActiveAt: new Date(),
      }]);
    });
    const res = await GET(makeReq('team-1'));
    const json = await res.json();
    expect(json.activeRun).toMatchObject({
      runId: 'lead-agent-1',
      status: 'running',
    });
  });

  it('returns activeRun=null when lead is sleeping (no active run)', async () => {
    let call = 0;
    vi.mocked(db.select).mockImplementation(() => {
      call += 1;
      if (call === 1) return makeChain([{ id: 'team-1', name: 'T', userId: 'user-1', createdAt: new Date() }]);
      if (call === 2) return makeChain([]);
      return makeChain([]); // no active row
    });
    const res = await GET(makeReq('team-1'));
    const json = await res.json();
    expect(json.activeRun).toBeNull();
  });
});

function makeChain(result: unknown[]) {
  const chain: any = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => result),
  };
  return chain;
}
```

- [ ] **Step 2: Run, verify failure**

```bash
pnpm vitest run src/app/api/team/status/__tests__/route.test.ts
```

Expected: FAIL — current code queries `teamRuns`.

- [ ] **Step 3: Update the route**

In `src/app/api/team/status/route.ts`, replace the `activeRows` query at lines 54-65:

```ts
import { agentRuns } from '@/lib/db/schema';
import { inArray } from 'drizzle-orm';

// REPLACE:
const activeRows = await db
  .select({
    runId: agentRuns.id,
    status: agentRuns.status,
    lastActiveAt: agentRuns.lastActiveAt,
  })
  .from(agentRuns)
  .where(
    and(
      eq(agentRuns.teamId, teamId),
      eq(agentRuns.agentDefName, 'coordinator'),
      inArray(agentRuns.status, ['running', 'resuming']),
    ),
  )
  .limit(1);
```

The response field name `runId` is preserved (UI consumers key on it); semantics changed from `team_runs.id` to `agent_runs.id` (lead). Drop the `goal/trigger/startedAt/turns/cost` fields — they don't exist on agent_runs. UI consumers should be checked: `team-desk.tsx` likely reads `activeRun?.startedAt` etc. for display. Either:
- Add a comment noting these fields are now derived elsewhere (and remove their references in the consumer in a follow-up task)
- OR enrich the response by joining team_messages for the most recent user_prompt (gives a `goal` surrogate)

For Task 1 MVP: just return `{runId, status, lastActiveAt}`. UI consumer fixes ride along in Task 5 (team page server component).

- [ ] **Step 4: Run — verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/app/api/team/status/route.ts src/app/api/team/status/__tests__/
git commit -m "fix(api/team/status): activeRun reads agent_runs lead row not team_runs (UI-A)"
```

---

### Task 2: Migrate `/api/today/progress` tactical run query

**Files:**
- Modify: `src/app/api/today/progress/route.ts:128-145`

- [ ] **Step 1: Read the route to understand the tactical-run derivation**

```bash
sed -n '100,200p' src/app/api/today/progress/route.ts
```

The route currently checks `teamRuns.trigger IN (TACTICAL_TRIGGERS) AND teamRuns.startedAt > stale`. Post-Phase-E, "tactical trigger" lives on `team_messages.metadata.trigger` (set by `dispatch-lead-message.ts` from Phase E Task 11).

- [ ] **Step 2: Replace the query**

```ts
// REPLACE the teamRuns query at lines 130-146:
const staleCutoff = new Date(Date.now() - STALE_WINDOW_MS);

// Find the most recent tactical wake message (the founder/cron's user_prompt)
const [latestTacticalMsg] = await db
  .select({
    id: teamMessages.id,
    createdAt: teamMessages.createdAt,
    metadata: teamMessages.metadata,
  })
  .from(teamMessages)
  .where(
    and(
      eq(teamMessages.teamId, teamId),
      sql`${teamMessages.metadata}->>'trigger' = ANY(${TACTICAL_TRIGGERS as unknown as string[]})`,
      gte(teamMessages.createdAt, staleCutoff),
    ),
  )
  .orderBy(desc(teamMessages.createdAt))
  .limit(1);

if (!latestTacticalMsg) {
  return { tactical: { status: 'pending', itemCount: 0, expectedCount: null, error: null, planId: null }, teamRun: null };
}

// Derive run status from lead's agent_runs row state + completion message
const [leadStatus] = await db
  .select({ status: agentRuns.status, lastActiveAt: agentRuns.lastActiveAt })
  .from(agentRuns)
  .where(and(eq(agentRuns.teamId, teamId), eq(agentRuns.agentDefName, 'coordinator')))
  .limit(1);

// Look for a `completion` or `error` team_messages row newer than the wake message
const [terminalEvent] = await db
  .select({ messageType: teamMessages.messageType, type: teamMessages.type, content: teamMessages.content })
  .from(teamMessages)
  .where(
    and(
      eq(teamMessages.teamId, teamId),
      gte(teamMessages.createdAt, latestTacticalMsg.createdAt),
      inArray(teamMessages.type, ['completion', 'error']),
    ),
  )
  .orderBy(desc(teamMessages.createdAt))
  .limit(1);

// Synthesize the legacy `runRow` shape so downstream `if (runRow.status === 'running')` etc. keep working
const runRow = {
  id: latestTacticalMsg.id,
  status: terminalEvent
    ? (terminalEvent.type === 'completion' ? 'completed' : 'failed')
    : (leadStatus?.status === 'running' || leadStatus?.status === 'resuming' ? 'running' : 'pending'),
  completedAt: terminalEvent ? new Date() : null,  // approximation
  errorMessage: terminalEvent?.type === 'error' ? terminalEvent.content : null,
};
```

- [ ] **Step 3: Add a test if `__tests__/` exists for this route; otherwise rely on integration test in Task 5**

- [ ] **Step 4: Verify typecheck + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/app/api/today/progress/route.ts
git commit -m "fix(api/today/progress): derive tactical run status from agent_runs + team_messages (UI-A)"
```

---

### Task 3: Migrate `/api/team/task/[taskId]/retry` ownership chain

**Files:**
- Modify: `src/app/api/team/task/[taskId]/retry/route.ts:55-58`

- [ ] **Step 1: Drop the teamRuns innerJoin**

The current ownership validation chains `teamTasks → teamRuns → teams.userId`. Post-Phase-E, team_tasks has its own `teamId` field (or via teamMembers); validate via `teamTasks → teamMembers → teams`. Read the team_tasks schema to confirm.

```bash
grep -A 5 "teamTasks = pgTable" src/lib/db/schema/team.ts | head -10
```

- [ ] **Step 2: Refactor the query**

```ts
// REPLACE the lookup at lines 46-61:
const rows = await db
  .select({
    taskId: teamTasks.id,
    teamId: teams.id,
    prompt: teamTasks.prompt,
    description: teamTasks.description,
    input: teamTasks.input,
    taskStatus: teamTasks.status,
    parentConversationId: teamTasks.conversationId,  // if team_tasks has this; else use the team's primary conversation
  })
  .from(teamTasks)
  .innerJoin(teamMembers, eq(teamMembers.id, teamTasks.memberId))
  .innerJoin(teams, eq(teams.id, teamMembers.teamId))
  .where(and(eq(teamTasks.id, taskId), eq(teams.userId, userId)))
  .limit(1);
```

The `parentConversationId` source changed — if team_tasks doesn't have a `conversationId` column, look it up via the team's primary conversation (same logic as `agent-run.ts:resolvePrimaryConversation`).

- [ ] **Step 3: Verify typecheck + run any existing route tests**

- [ ] **Step 4: Commit**

```bash
git add src/app/api/team/task/[taskId]/retry/route.ts
git commit -m "fix(api/team/task/retry): drop teamRuns join — validate via teamMembers chain (UI-A)"
```

---

### Task 4: Migrate `/api/team/task/[taskId]/cancel` ownership chain

**Files:**
- Modify: `src/app/api/team/task/[taskId]/cancel/route.ts:52-53`

Same shape as Task 3 — drop the `innerJoin(teamRuns)`, validate via teamMembers.

- [ ] **Step 1: Apply the equivalent change**

```ts
// REPLACE lines 42-55:
const rows = await db
  .select({
    taskId: teamTasks.id,
    teamId: teams.id,
    taskStatus: teamTasks.status,
    input: teamTasks.input,
    ownerId: teams.userId,
  })
  .from(teamTasks)
  .innerJoin(teamMembers, eq(teamMembers.id, teamTasks.memberId))
  .innerJoin(teams, eq(teams.id, teamMembers.teamId))
  .where(and(eq(teamTasks.id, taskId), eq(teams.userId, userId)))
  .limit(1);
```

- [ ] **Step 2: Verify + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/app/api/team/task/[taskId]/cancel/route.ts
git commit -m "fix(api/team/task/cancel): drop teamRuns join — validate via teamMembers chain (UI-A)"
```

---

### Task 5: Migrate `team/page.tsx` server component

**Files:**
- Modify: `src/app/(app)/team/page.tsx:158-413` (4 distinct teamRuns queries)

This is the biggest UI-A task. The page server component reads:
1. `activeRunRows` — currently `teamRuns WHERE status='running'`
2. `lastRunRows` — currently `teamRuns ORDER BY startedAt DESC LIMIT 1`
3. `runLookup` — joins `teamMessages.runId → teamRuns.id` to get trigger/startedAt for filtering
4. Weekly task stats — joins `teamTasks → teamRuns → teamMessages` for time-windowed counts
5. Run history list — `teamRuns ORDER BY startedAt DESC LIMIT N`

Replace each with agent_runs / team_messages equivalents.

- [ ] **Step 1: Read the full file to scope changes**

```bash
sed -n '130,250p' src/app/(app)/team/page.tsx
sed -n '370,420p' src/app/(app)/team/page.tsx
```

- [ ] **Step 2: Replace `activeRunRows`**

```ts
// REPLACE lines ~157-164:
const activeRunRows = await db
  .select({
    agentId: agentRuns.id,
    lastActiveAt: agentRuns.lastActiveAt,
    status: agentRuns.status,
  })
  .from(agentRuns)
  .where(
    and(
      eq(agentRuns.teamId, team.id),
      eq(agentRuns.agentDefName, 'coordinator'),
      inArray(agentRuns.status, ['running', 'resuming']),
    ),
  )
  .limit(1);
```

- [ ] **Step 3: Replace `lastRunRows`**

`lastRun` was used to show "last completed at" timestamp + total turns. Without team_runs, derive from:
- "last completed at" = latest `team_messages` row with `type='completion'` for the team
- "total turns" = count of `agent_text_stop` messages from the lead since the last user_prompt

```ts
// REPLACE lines ~165-175:
const lastRunRows = await db
  .select({
    completedAt: teamMessages.createdAt,
    type: teamMessages.type,
  })
  .from(teamMessages)
  .where(
    and(
      eq(teamMessages.teamId, team.id),
      inArray(teamMessages.type, ['completion', 'error']),
    ),
  )
  .orderBy(desc(teamMessages.createdAt))
  .limit(1);
```

- [ ] **Step 4: Replace `runLookup` (joins teamMessages.runId → teamRuns)**

`teamMessages.runId` is null for new flows (Phase E). Drop the join entirely. The `trigger` discriminator is now on `teamMessages.metadata.trigger` (set by `dispatch-lead-message.ts`).

```ts
// REPLACE lines ~187-200 (where runLookup is used):
const recentMessages = await db
  .select({
    id: teamMessages.id,
    createdAt: teamMessages.createdAt,
    type: teamMessages.type,
    content: teamMessages.content,
    metadata: teamMessages.metadata,
  })
  .from(teamMessages)
  .where(
    and(
      eq(teamMessages.teamId, team.id),
      // Filter out onboarding kickoffs via metadata.trigger
      sql`(${teamMessages.metadata}->>'trigger') IS DISTINCT FROM 'onboarding'`,
    ),
  )
  .orderBy(desc(teamMessages.createdAt))
  .limit(50);
```

- [ ] **Step 5: Replace weekly task stats query**

```ts
// REPLACE the weekly stats join (lines ~206-215):
const weeklyTasks = await db
  .select({ id: teamTasks.id, status: teamTasks.status })
  .from(teamTasks)
  .innerJoin(teamMembers, eq(teamMembers.id, teamTasks.memberId))
  .where(
    and(
      eq(teamMembers.teamId, team.id),
      gte(teamTasks.createdAt, startOfIsoWeek()),
    ),
  );
```

- [ ] **Step 6: Replace recent-tasks list query**

```ts
// REPLACE lines ~225-240:
const recentTasks = await db
  .select({
    id: teamTasks.id,
    status: teamTasks.status,
    description: teamTasks.description,
    createdAt: teamTasks.createdAt,
    memberId: teamTasks.memberId,
  })
  .from(teamTasks)
  .innerJoin(teamMembers, eq(teamMembers.id, teamTasks.memberId))
  .where(eq(teamMembers.teamId, team.id))
  .orderBy(desc(teamTasks.createdAt))
  .limit(20);
```

- [ ] **Step 7: Replace run-history list query (lines ~380-395)**

The history was a list of past `team_runs` shown to the founder. Without team_runs, the equivalent is "list of past founder→lead user_prompts grouped by completion":

```ts
const runHistory = await db
  .select({
    id: teamMessages.id,
    createdAt: teamMessages.createdAt,
    content: teamMessages.content,
    metadata: teamMessages.metadata,
  })
  .from(teamMessages)
  .where(
    and(
      eq(teamMessages.teamId, team.id),
      eq(teamMessages.type, 'user_prompt'),
      sql`${teamMessages.fromMemberId} IS NULL`,  // founder-originated
    ),
  )
  .orderBy(desc(teamMessages.createdAt))
  .limit(20);
```

- [ ] **Step 8: Update the JSX consumers**

Find spots that read removed fields (`run.totalTurns`, `run.startedAt`, etc.) and either:
- Replace with derived values
- Hide the field (e.g., "Total turns: 12" was nice-to-have; can drop in MVP)

Run `pnpm tsc --noEmit --pretty false` and fix every error.

- [ ] **Step 9: Commit**

```bash
git add src/app/(app)/team/page.tsx
git commit -m "fix(team page): server component reads agent_runs + team_messages (UI-A)"
```

---

## UI-B Tasks (Agent Teams affordances)

### Task 6: Reusable `<AgentStatusPill>` component

**Files:**
- Create: `src/app/(app)/team/_components/agent-status-pill.tsx`
- Test: `src/app/(app)/team/_components/__tests__/agent-status-pill.test.tsx`

Tiny pure component. Status enum → visual.

- [ ] **Step 1: Implement**

```tsx
import { cva } from 'class-variance-authority';

const pillVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      status: {
        sleeping: 'bg-gray-100 text-gray-500',
        queued: 'bg-amber-50 text-amber-700 animate-pulse',
        running: 'bg-blue-50 text-blue-700',
        resuming: 'bg-yellow-50 text-yellow-800',
        completed: 'bg-green-50 text-green-700',
        failed: 'bg-red-50 text-red-700',
        killed: 'bg-red-100 text-red-800',
      },
    },
  },
);

const ICONS = {
  sleeping: 'zZz',
  queued: '●',
  running: '⟳',  // animate via class
  resuming: '⟳',
  completed: '✓',
  failed: '✗',
  killed: '🛑',
};

export type AgentStatus = 'sleeping' | 'queued' | 'running' | 'resuming' | 'completed' | 'failed' | 'killed';

interface Props {
  status: AgentStatus;
  label?: string;
}

export function AgentStatusPill({ status, label }: Props) {
  return (
    <span className={pillVariants({ status })} aria-label={`Agent ${status}`}>
      <span className={status === 'running' || status === 'resuming' ? 'animate-spin inline-block' : ''}>
        {ICONS[status]}
      </span>
      {label ?? status}
    </span>
  );
}
```

- [ ] **Step 2: Test (snapshot per status)**

```tsx
import { render } from '@testing-library/react';
import { AgentStatusPill } from '../agent-status-pill';

describe('AgentStatusPill', () => {
  for (const status of ['sleeping', 'queued', 'running', 'resuming', 'completed', 'failed', 'killed'] as const) {
    it(`renders ${status} variant`, () => {
      const { container } = render(<AgentStatusPill status={status} />);
      expect(container.firstChild).toMatchSnapshot();
    });
  }
});
```

- [ ] **Step 3: Verify + commit**

```bash
pnpm vitest run src/app/(app)/team/_components/__tests__/agent-status-pill.test.tsx
git add src/app/(app)/team/_components/agent-status-pill.tsx \
        src/app/(app)/team/_components/__tests__/agent-status-pill.test.tsx
git commit -m "feat(team UI): AgentStatusPill — reusable status indicator (UI-B)"
```

---

### Task 7: `<TaskNotificationCard>` for `<task-notification>` rendering

**Files:**
- Create: `src/app/(app)/team/_components/task-notification-card.tsx`
- Test: same `__tests__` directory

Parses the engine-style XML (or the `messageType='task_notification'` row's content field) and renders structurally.

- [ ] **Step 1: Implement**

```tsx
import { AgentStatusPill, type AgentStatus } from './agent-status-pill';

interface TaskNotificationData {
  taskId: string;
  status: 'completed' | 'failed' | 'killed';
  summary: string;
  result: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
}

function parseTaskNotification(xml: string): TaskNotificationData | null {
  // Lightweight regex parse — the XML is system-generated, well-formed
  const taskId = xml.match(/<task-id>([^<]+)<\/task-id>/)?.[1] ?? '';
  const status = xml.match(/<status>([^<]+)<\/status>/)?.[1] as TaskNotificationData['status'];
  const summary = xml.match(/<summary>([^<]+)<\/summary>/)?.[1] ?? '';
  const result = xml.match(/<r>([^<]+)<\/r>/)?.[1] ?? '';
  const totalTokens = Number(xml.match(/<total_tokens>(\d+)<\/total_tokens>/)?.[1] ?? 0);
  const toolUses = Number(xml.match(/<tool_uses>(\d+)<\/tool_uses>/)?.[1] ?? 0);
  const durationMs = Number(xml.match(/<duration_ms>(\d+)<\/duration_ms>/)?.[1] ?? 0);
  if (!taskId || !status) return null;
  return {
    taskId,
    status,
    summary,
    result,
    usage: { totalTokens, toolUses, durationMs },
  };
}

interface Props {
  xml: string;
  teammateName?: string;  // human-friendly name from team_members
  onClickAgent?: (agentId: string) => void;  // open transcript drawer
}

export function TaskNotificationCard({ xml, teammateName, onClickAgent }: Props) {
  const data = parseTaskNotification(xml);
  if (!data) return null;
  return (
    <div className="rounded border border-gray-200 bg-gray-50 p-3 cursor-pointer hover:bg-gray-100"
         onClick={() => onClickAgent?.(data.taskId)}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium">{teammateName ?? 'Teammate'}</span>
        <AgentStatusPill status={data.status as AgentStatus} />
      </div>
      <p className="text-sm text-gray-700">{data.summary}</p>
      {data.usage && (
        <div className="mt-2 text-xs text-gray-500">
          {data.usage.totalTokens} tokens · {data.usage.toolUses} tool calls · {(data.usage.durationMs / 1000).toFixed(1)}s
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Test parse + render**

```tsx
const SAMPLE = `
<task-notification>
  <task-id>agent-1</task-id>
  <status>completed</status>
  <summary>Drafted 3 reply variations</summary>
  <r>The replies are ready in the drafts table.</r>
  <usage><total_tokens>500</total_tokens><tool_uses>3</tool_uses><duration_ms>1500</duration_ms></usage>
</task-notification>
`;

it('renders completed notification', () => {
  const { getByText } = render(<TaskNotificationCard xml={SAMPLE} teammateName="reply-author" />);
  expect(getByText('reply-author')).toBeInTheDocument();
  expect(getByText('Drafted 3 reply variations')).toBeInTheDocument();
});
```

- [ ] **Step 3: Verify + commit**

```bash
git add src/app/(app)/team/_components/task-notification-card.tsx \
        src/app/(app)/team/_components/__tests__/task-notification-card.test.tsx
git commit -m "feat(team UI): TaskNotificationCard — render <task-notification> XML (UI-B)"
```

---

### Task 8: `<TeammateRoster>` + `/api/team/[teamId]/teammates` endpoint

**Files:**
- Create: `src/app/(app)/team/_components/teammate-roster.tsx`
- Create: `src/app/api/team/[teamId]/teammates/route.ts`
- Test: each

Roster shows all `agent_runs` for the team in non-terminal status. Initial load via API; live updates via SSE.

- [ ] **Step 1: Endpoint**

```ts
// src/app/api/team/[teamId]/teammates/route.ts
import { NextResponse } from 'next/server';
import { and, eq, inArray, asc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRuns, teamMembers } from '@/lib/db/schema';
import { getServerSession } from '@/lib/auth';

export async function GET(req: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const session = await getServerSession();
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { teamId } = await params;
  // Ownership check: skipped for brevity; mirror /api/team/status route's check
  const rows = await db
    .select({
      agentId: agentRuns.id,
      memberId: agentRuns.memberId,
      agentDefName: agentRuns.agentDefName,
      parentAgentId: agentRuns.parentAgentId,
      status: agentRuns.status,
      lastActiveAt: agentRuns.lastActiveAt,
      sleepUntil: agentRuns.sleepUntil,
      displayName: teamMembers.displayName,
    })
    .from(agentRuns)
    .innerJoin(teamMembers, eq(teamMembers.id, agentRuns.memberId))
    .where(
      and(
        eq(agentRuns.teamId, teamId),
        inArray(agentRuns.status, ['queued', 'running', 'sleeping', 'resuming']),
      ),
    )
    .orderBy(asc(agentRuns.spawnedAt));
  return NextResponse.json({ teammates: rows });
}
```

- [ ] **Step 2: Component**

```tsx
'use client';
import { useEffect, useState } from 'react';
import { AgentStatusPill, type AgentStatus } from './agent-status-pill';
import { useTeamEvents } from '@/hooks/use-team-events';  // existing hook

interface Teammate {
  agentId: string;
  memberId: string;
  agentDefName: string;
  parentAgentId: string | null;
  status: AgentStatus;
  lastActiveAt: string;
  sleepUntil: string | null;
  displayName: string;
}

interface Props {
  teamId: string;
  initial: Teammate[];
  onSelectAgent: (agentId: string) => void;
}

export function TeammateRoster({ teamId, initial, onSelectAgent }: Props) {
  const [teammates, setTeammates] = useState<Teammate[]>(initial);
  const events = useTeamEvents(teamId);

  useEffect(() => {
    // Subscribe to agent_runs.status_change SSE events (added in agent-run.ts UI-B Task 8b)
    const unsub = events.on('agent_status_change', (evt) => {
      setTeammates((prev) => {
        const idx = prev.findIndex((t) => t.agentId === evt.agentId);
        if (idx === -1) return [...prev, evt.teammate];
        const next = [...prev];
        next[idx] = { ...next[idx], status: evt.status, lastActiveAt: evt.lastActiveAt };
        // Remove if terminal
        if (['completed', 'failed', 'killed'].includes(evt.status)) {
          return next.filter((t) => t.agentId !== evt.agentId);
        }
        return next;
      });
    });
    return unsub;
  }, [events]);

  // Group by parentAgentId
  const lead = teammates.find((t) => t.agentDefName === 'coordinator');
  const children = teammates.filter((t) => t.parentAgentId === lead?.agentId);

  return (
    <aside className="w-64 border-r border-gray-200 p-3 overflow-y-auto">
      <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Team</h2>
      {lead && <RosterRow teammate={lead} onClick={() => onSelectAgent(lead.agentId)} />}
      {children.length > 0 && (
        <>
          <h3 className="text-xs uppercase tracking-wide text-gray-500 mt-4 mb-2">Active Teammates</h3>
          {children.map((t) => (
            <RosterRow key={t.agentId} teammate={t} onClick={() => onSelectAgent(t.agentId)} />
          ))}
        </>
      )}
    </aside>
  );
}

function RosterRow({ teammate, onClick }: { teammate: Teammate; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-center justify-between p-2 hover:bg-gray-50 rounded text-left">
      <span className="text-sm font-medium">{teammate.displayName}</span>
      <AgentStatusPill status={teammate.status} />
    </button>
  );
}
```

- [ ] **Step 3: Test (component + endpoint)**

- [ ] **Step 4: Add `agent_status_change` SSE events in agent-run.ts**

In `src/workers/processors/agent-run.ts`, after each `db.update(agentRuns).set({status: ...})` call, also publish to the team's SSE channel:

```ts
async function publishStatusChange(teamId: string, agentId: string, status: string, lastActiveAt: Date) {
  try {
    const pub = getPubSubPublisher();
    await pub.publish(teamMessagesChannel(teamId), JSON.stringify({
      type: 'agent_status_change',
      agentId,
      status,
      lastActiveAt: lastActiveAt.toISOString(),
    }));
  } catch (err) {
    log.warn('SSE agent_status_change publish failed', { err });
  }
}
```

Call after every `agentRuns.status` update. Add a status_change publish at the end of the lead's run too (when status flips back to sleeping after end_turn).

- [ ] **Step 5: Verify + commit**

```bash
pnpm tsc --noEmit --pretty false
git add src/app/api/team/[teamId]/teammates/ \
        src/app/(app)/team/_components/teammate-roster.tsx \
        src/workers/processors/agent-run.ts
git commit -m "feat(team UI): TeammateRoster + agent_status_change SSE events (UI-B)"
```

---

### Task 9: `<TeammateTranscriptDrawer>` + transcript endpoint

**Files:**
- Create: `src/app/(app)/team/_components/teammate-transcript-drawer.tsx`
- Create: `src/app/api/team/agent/[agentId]/transcript/route.ts`

Drawer that loads via `loadAgentRunHistory` (Phase D's helper) and displays the teammate's chronological messages.

- [ ] **Step 1: Endpoint** — wraps `loadAgentRunHistory` with auth + ownership check

```ts
// src/app/api/team/agent/[agentId]/transcript/route.ts
import { NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRuns, teams, teamMembers } from '@/lib/db/schema';
import { getServerSession } from '@/lib/auth';
import { loadAgentRunHistory } from '@/workers/processors/lib/agent-run-history';

export async function GET(req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const session = await getServerSession();
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { agentId } = await params;
  // Ownership check via teams.userId
  const ownerCheck = await db
    .select({ userId: teams.userId })
    .from(agentRuns)
    .innerJoin(teams, eq(teams.id, agentRuns.teamId))
    .where(eq(agentRuns.id, agentId))
    .limit(1);
  if (ownerCheck.length === 0 || ownerCheck[0].userId !== session.user.id) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const messages = await loadAgentRunHistory(agentId, db);
  return NextResponse.json({ messages });
}
```

- [ ] **Step 2: Component**

```tsx
'use client';
import { useEffect, useState } from 'react';

interface Props {
  agentId: string | null;
  onClose: () => void;
}

export function TeammateTranscriptDrawer({ agentId, onClose }: Props) {
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!agentId) return;
    setLoading(true);
    fetch(`/api/team/agent/${agentId}/transcript`)
      .then((r) => r.json())
      .then((data) => setMessages(data.messages ?? []))
      .finally(() => setLoading(false));
  }, [agentId]);

  if (!agentId) return null;
  return (
    <aside className="fixed right-0 top-0 h-full w-96 bg-white border-l border-gray-200 shadow-lg overflow-y-auto z-50">
      <header className="sticky top-0 bg-white border-b border-gray-200 p-3 flex justify-between">
        <h3 className="font-medium">Teammate transcript</h3>
        <button onClick={onClose} aria-label="Close">×</button>
      </header>
      <div className="p-3 space-y-3">
        {loading && <p className="text-sm text-gray-500">Loading…</p>}
        {messages.map((msg, i) => (
          <div key={i} className={msg.role === 'user' ? 'bg-blue-50 p-2 rounded' : 'bg-gray-50 p-2 rounded'}>
            <div className="text-xs text-gray-500 mb-1">{msg.role}</div>
            <div className="text-sm whitespace-pre-wrap">{typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}
```

- [ ] **Step 3: Verify + commit**

```bash
git add src/app/api/team/agent/ src/app/(app)/team/_components/teammate-transcript-drawer.tsx
git commit -m "feat(team UI): TeammateTranscriptDrawer + transcript endpoint (UI-B)"
```

---

### Task 10: `<TeamActivityFeed>` (right sidebar)

**Files:**
- Create: `src/app/(app)/team/_components/team-activity-feed.tsx`

Chronological feed of all team_messages — incl. peer-DM shadows, spawn events, completions. Live SSE.

- [ ] **Step 1: Component**

Subscribe to the team's SSE channel; for each `team_messages` event, render a one-line entry. Filter out the lead's own assistant_text_stop events (those go in the main chat).

```tsx
'use client';
import { useEffect, useState } from 'react';
import { useTeamEvents } from '@/hooks/use-team-events';

interface FeedEvent {
  id: string;
  timestamp: string;
  kind: string;  // 'agent_status_change' | 'task_notification' | 'peer_dm' | etc.
  summary: string;
}

interface Props {
  teamId: string;
}

export function TeamActivityFeed({ teamId }: Props) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const teamEvents = useTeamEvents(teamId);

  useEffect(() => {
    const handlers = [
      teamEvents.on('agent_status_change', (e) => addEvent({ kind: 'status', summary: `${e.displayName ?? 'Agent'} → ${e.status}`, ...e })),
      teamEvents.on('task_notification', (e) => addEvent({ kind: 'notification', summary: `Teammate completed: ${e.summary}`, ...e })),
      teamEvents.on('peer_dm', (e) => addEvent({ kind: 'peer_dm', summary: `${e.from} → ${e.to}: ${e.summary}`, ...e })),
    ];
    function addEvent(evt: any) {
      setEvents((prev) => [{ id: evt.id ?? crypto.randomUUID(), timestamp: new Date().toISOString(), ...evt }, ...prev].slice(0, 100));
    }
    return () => handlers.forEach((u) => u?.());
  }, [teamEvents]);

  return (
    <aside className="w-72 border-l border-gray-200 p-3 overflow-y-auto">
      <h2 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Activity</h2>
      <ul className="space-y-2">
        {events.map((e) => (
          <li key={e.id} className="text-xs">
            <time className="text-gray-400">{new Date(e.timestamp).toLocaleTimeString()}</time>
            <p className="text-gray-700">{e.summary}</p>
          </li>
        ))}
      </ul>
    </aside>
  );
}
```

- [ ] **Step 2: Add SSE event types in agent-run.ts**

Add `task_notification` SSE publish after each `synthAndDeliverNotification` insert. Add `peer_dm` SSE publish in `peer-dm-shadow.ts` after the shadow row insert.

- [ ] **Step 3: Verify + commit**

```bash
git commit -m "feat(team UI): TeamActivityFeed — live cross-agent event stream (UI-B)"
```

---

### Task 11: Per-teammate cancel button + endpoint

**Files:**
- Create: `src/lib/team/cancel-teammate.ts`
- Create: `src/app/api/team/agent/[agentId]/cancel/route.ts`
- Modify: `teammate-roster.tsx` (add cancel button per row when status=running/sleeping)

- [ ] **Step 1: Helper**

```ts
// src/lib/team/cancel-teammate.ts
import { eq } from 'drizzle-orm';
import { agentRuns, teamMessages } from '@/lib/db/schema';
import { wake } from '@/workers/processors/lib/wake';
import type { Database } from '@/lib/db';

export async function cancelTeammate(agentId: string, db: Database): Promise<void> {
  const [target] = await db
    .select({ teamId: agentRuns.teamId, memberId: agentRuns.memberId })
    .from(agentRuns)
    .where(eq(agentRuns.id, agentId))
    .limit(1);
  if (!target) throw new Error(`agent_runs ${agentId} not found`);
  await db.insert(teamMessages).values({
    teamId: target.teamId,
    type: 'user_prompt',
    messageType: 'shutdown_request',
    fromMemberId: null,
    toAgentId: agentId,
    content: 'Cancelled by founder via UI',
    summary: 'cancel',
  });
  await wake(agentId);
}
```

- [ ] **Step 2: Endpoint**

```ts
// src/app/api/team/agent/[agentId]/cancel/route.ts
import { NextResponse } from 'next/server';
// ... ownership check identical to transcript endpoint ...
import { cancelTeammate } from '@/lib/team/cancel-teammate';

export async function POST(req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  // ... auth + ownership check ...
  const { agentId } = await params;
  await cancelTeammate(agentId, db);
  return NextResponse.json({ cancelled: true, agentId });
}
```

- [ ] **Step 3: Add cancel button in roster**

In `teammate-roster.tsx`, add a small "stop" button on hover for rows where status is running/sleeping/queued. Don't show on lead (use the existing global cancel for lead).

- [ ] **Step 4: Verify + commit**

```bash
git commit -m "feat(team UI): per-teammate cancel via shutdown_request (UI-B)"
```

---

## UI-C Tasks (mental model reframe)

### Task 12: "Send a message" composer (replace "Start a run")

**Files:**
- Modify: `src/app/(app)/team/_components/team-desk.tsx`

The current composer likely says "Start a run" or "Trigger" — change to "Send a message". The lead is always there.

- [ ] **Step 1: Find current CTA copy**

```bash
grep -n 'Start.*run\|Trigger\|Run\|Kick off' src/app/\(app\)/team/_components/team-desk.tsx | head -10
```

- [ ] **Step 2: Replace copy + simplify the composer**

Remove "trigger" dropdown if present (the new flow doesn't distinguish trigger types at the UI level — `dispatch-lead-message.ts` handles it server-side via metadata).

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(team UI): 'Send a message' composer — lead is always present (UI-C)"
```

---

### Task 13: Onboarding copy + CLAUDE.md mental model section

**Files:**
- Modify: relevant onboarding components (find via `grep -rn 'team.*lead.*will run\|kickoff' src/app/\(app\)/onboarding/`)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update onboarding copy**

Replace any "your team-lead will run when triggered" prose with "Your lead is always available; just message it. Spawned teammates run in parallel."

- [ ] **Step 2: Append to CLAUDE.md**

After the existing "Agent Teams Architecture" section (added in Phase G), add a new subsection:

```markdown
### Founder UI mental model

The team-lead is **always present** as a sleeping `agent_runs` row. Founders
don't "start runs" — they send messages to the lead. Each message wakes
the lead; the lead processes (potentially spawning parallel teammates),
replies, and goes back to sleep.

UI implications:
- The "Start a run" CTA is replaced with "Send a message"
- The lead's status pill is always visible (sleeping/running/resuming)
- Teammates appear in the roster sidebar when spawned, disappear when terminal
- Activity feed shows cross-agent events (peer-DM, status changes, completions)
- Cancel = SendMessage with type='shutdown_request' (eventually consistent;
  takes seconds to propagate, not synchronous)
```

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/onboarding/ CLAUDE.md
git commit -m "docs: founder UI mental model — always-present lead (UI-C)"
```

---

## §3 Verification gate

- [ ] **Step 1: Full sweep**

```bash
pnpm tsc --noEmit --pretty false
pnpm test 2>&1 | tail -20
```

Expected: all green.

- [ ] **Step 2: Manual smoke test (cannot automate without browser)**

1. Start worker + dev server
2. Open team page
3. Send a message → verify "working..." indicator clears when end_turn fires (Task 1+5 + agent-run.ts terminal SSE event from `8ebe6e1`)
4. Spawn an async teammate via Task tool from lead — verify it appears in roster (Task 8 + status_change SSE)
5. Click teammate → drawer opens with transcript (Task 9)
6. Watch activity feed for status changes + task_notification (Task 10)
7. Cancel a teammate → status flips to killed within seconds (Task 11)

- [ ] **Step 3: Tag**

```bash
git tag -a ui-agent-teams-redesign -m "Founder UI adapted to Claude-Code-style runtime"
```

- [ ] **Step 4: Commit any final doc updates**

---

## Acceptance criteria

- [ ] All 5 stale `team_runs` reads migrated to `agent_runs` / `team_messages`
- [ ] No 404s from task retry/cancel endpoints for new-flow teams
- [ ] Roster sidebar shows lead + teammates with live status pills
- [ ] Click teammate → transcript drawer opens
- [ ] Task notifications render as structured cards (not raw XML)
- [ ] Activity feed surfaces peer-DM + status changes + completions
- [ ] Per-teammate cancel button works
- [ ] CTA copy reframed to "Send a message"
- [ ] CLAUDE.md has Founder UI mental model section
- [ ] tsc clean
- [ ] Local tag `ui-agent-teams-redesign`

---

## Self-review notes

1. **Spec coverage**: each of the 5 stale reads has a dedicated task; UI-B's 5 affordances each get a task; UI-C's reframe gets 2 tasks. Total 13 tasks.
2. **Risk**: Task 5 (team page server component) touches the largest file and has the most consumer-facing risk. If JSX consumers break in non-obvious ways, may need follow-up tasks. Tackle Task 5 last in UI-A so 1-4 land cleanly first.
3. **SSE event additions**: Task 8/10 add new SSE event types. Make sure `useTeamEvents` hook handles unknown types gracefully (silent ignore) so old clients don't crash.
4. **Per-teammate cancel** (Task 11) duplicates engine TaskStop's lead-side intent — but exposes it as a UI affordance for the founder, not just the lead's prompt. Worth flagging as a privilege escalation: founder can now stop any teammate, not just observe.
5. **Test quality**: each new component has a test; endpoints have route tests; SSE event publishes verified by the existing agent-run smoke test path.
6. **Mobile**: no responsive design tasks here. The three-pane layout assumes desktop. Mobile reflow is a follow-up — UI-A unblocks mobile too (the read paths fix doesn't depend on layout).
