# Drop team_runs Table + Migrate Admin Pages to Per-Request View (Option C2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Phase G cleanup that never happened. Drop the dead `team_runs` table (no writers since Phase E), drop the FK constraints from `team_tasks.run_id` and `team_messages.run_id` that were causing Task tool to crash, restore the `runId` writes to `team_messages` (which were skipped due to the FK), delete the dead `enqueueTeamRun` helper, and migrate the `/admin/team-runs/*` pages from team_runs (per-historical-run-row) to per-request aggregation over team_messages (one row per user_prompt + its activity tree).

**Architecture:** Two tasks, sequential:

1. **Schema + dead code + writer fix** — single migration that drops FKs and the team_runs table, schema export removed, dead `enqueueTeamRun` deleted, `agent-run.ts` restored to write `runId` on all `team_messages` inserts (currently only on SSE payloads — see commit message of `0750a35` and the comment at `agent-run.ts:578-588` which explains the FK-driven workaround).

2. **Admin pages → per-request aggregation** — rewrite `/admin/team-runs/page.tsx` and `/admin/team-runs/[runId]/page.tsx` to read `team_messages` instead, with the user_prompt row as the "request" handle and all activity grouped by `runId`. Preserves the recently-committed `ownerEmail` enhancement. Drops `trigger` (no equivalent) and `totalCostUsd` (no per-message cost tracking today). Computes `totalTurns` by counting `agent_text` rows, `status` from terminal events, `goal` from user_prompt content.

**Tech Stack:** TypeScript, Drizzle ORM, Postgres, Next.js Route Handler / Server Component, Vitest.

**The reproducer the user reported:**
```
[worker] WRN [core:tools] Tool Task failed in 926ms: Failed query: insert into "team_tasks"
```
The hidden cause (on `err.cause`) is the FK violation: `team_tasks.run_id` FKs to `team_runs.id` and Phase E stopped writing `team_runs` rows.

---

## Pre-flight context (read once)

### Why this is safe to drop

- `enqueueTeamRun` (`src/lib/queue/team-run.ts:92`) has zero production callers (verified by `grep -rn "enqueueTeamRun(" src/` — only finds the def site itself + a stale doc reference).
- `team_runs` schema lives at `src/lib/db/schema/team.ts` (search for `export const teamRuns = pgTable`).
- Two callers of `team_runs.id` as a FK: `team_tasks.run_id` (notNull) and `team_messages.run_id` (nullable, currently skipped on inserts).
- The lead's `agent_runs` row is the new permanent entity — it doesn't represent a request; the user_prompt does.

### Request semantics (post-Phase-E)

- A "request" is anchored by a user_prompt row in `team_messages`:
  - `type: 'user_prompt'`
  - `messageType: 'message'`
  - `fromMemberId IS NULL` (external/founder origin)
  - `toAgentId IS NOT NULL` (sent to a specific agent — usually the lead)
- The lead's response activity (`agent_text`, `tool_call`, `tool_result`) carries `runId = user_prompt.id` (this is `leadRequestId` per `agent-run.ts:586-587`). Today this value is only emitted on SSE payloads, not persisted on rows.
- After this PR: `runId` IS persisted on all lead-side response rows. Old rows (pre-PR) stay with NULL `runId` — admin page filters its date range to "since this PR" (e.g., last 7 days) so the gap doesn't show.

### Build gate

- `pnpm tsc --noEmit --pretty false` exit 0.
- Vitest does NOT type-check. Run BOTH.
- Drizzle migrations: existing migrations live in `drizzle/`. Latest is `0015_colorful_human_cannonball.sql`. New migration goes in `drizzle/0016_<random>.sql` — name comes from `pnpm drizzle-kit generate` if the project uses that, OR just hand-write `drizzle/0016_drop_team_runs.sql` matching the existing style.

### Testing the migration

- `pnpm drizzle-kit migrate` (or whatever the project's migrate command is — grep `package.json scripts` for "migrate")
- Confirm the migration applies cleanly on a fresh dev DB and on a DB that already has team_runs data (the table drop is destructive — historical team_runs rows are GONE).

### Worktree branch reminder

⚠️ **Commit on `worktree-agent-<id>` — NOT on `dev`.** Run `git branch --show-current` before committing. Two recent prior tasks had implementers commit on dev directly; the controller had to reconcile. Don't repeat.

---

## Task 1: Schema migration + dead code + restore runId writes

**Files:**
- Create: `drizzle/0016_drop_team_runs.sql` (the migration)
- Modify: `drizzle/meta/_journal.json` (drizzle-kit usually does this)
- Modify: `drizzle/meta/0016_snapshot.json` (drizzle-kit usually does this)
- Modify: `src/lib/db/schema/team.ts` — remove `teamRuns` export + `.references(() => teamRuns.id, ...)` from `teamTasks.runId` AND `teamMessages.runId`. The columns stay; just the FK constraints leave.
- Modify: `src/lib/db/schema/index.ts` — remove the `teamRuns` re-export.
- Delete: `src/lib/queue/team-run.ts` (entire file — `enqueueTeamRun` has no production callers).
- Modify: `src/workers/processors/agent-run.ts` — restore `runId: isLead ? leadRequestId : agentId` to all 3 `team_messages` inserts in `handleStreamEvent` (assistant_text_stop, tool_call, tool_result). Currently the comment at line 584 says we DON'T stamp runId because of the FK risk. Now we DO stamp.
- Modify: tests that reference `teamRuns` or `enqueueTeamRun`. Most likely: `src/app/api/onboarding/commit/__tests__/route.test.ts` mocks `enqueueTeamRun`; it's already documented as a test-only mock so just remove the mock + assertion. Grep first: `grep -rn "teamRuns\|enqueueTeamRun" src/ --include="*.test.ts"`.

### Task 1 spec

**Migration `0016_drop_team_runs.sql`:**

```sql
-- Drop FK constraints. Names from drizzle's default convention; if `pnpm
-- drizzle-kit generate` produces different names, use those. The IF EXISTS
-- guards make the migration idempotent on dev DBs that may have varying
-- constraint names from past iterations.
ALTER TABLE "team_tasks" DROP CONSTRAINT IF EXISTS "team_tasks_run_id_team_runs_id_fk";
ALTER TABLE "team_messages" DROP CONSTRAINT IF EXISTS "team_messages_run_id_team_runs_id_fk";

-- Drop the table itself. CASCADE so any leftover dependent objects
-- (indexes, sequences, triggers) go with it. Historical team_runs data is
-- destroyed — Phase E stopped writing rows so this loses ~zero recent
-- ops data.
DROP TABLE IF EXISTS "team_runs" CASCADE;
```

**Schema changes (`src/lib/db/schema/team.ts`):**

In the `teamTasks` definition, change:
```ts
runId: text('run_id')
  .notNull()
  .references(() => teamRuns.id, { onDelete: 'cascade' }),
```
to:
```ts
// Phase G cleanup (drop_team_runs migration 0016): the FK to team_runs
// is gone. runId is now a free-text grouping handle that points at the
// user_prompt team_messages.id which initiated the request. Keep notNull
// because every Task spawn happens inside a request — never standalone.
runId: text('run_id').notNull(),
```

In the `teamMessages` definition, change:
```ts
runId: text('run_id').references(() => teamRuns.id, { onDelete: 'cascade' }),
```
to:
```ts
// Phase G cleanup: see teamTasks.runId comment. Nullable because system
// messages (cron broadcasts, etc.) may not be tied to a request.
runId: text('run_id'),
```

Then DELETE the entire `teamRuns` definition block (everything between `export const teamRuns = pgTable(` and the matching closing `);` plus the `export type TeamRun = ...` and `export type NewTeamRun = ...` lines below it).

**Schema barrel (`src/lib/db/schema/index.ts`):** remove the `teamRuns` re-export from the export list.

**Delete `src/lib/queue/team-run.ts` entirely.** Confirm no production imports first: `grep -rn "from '@/lib/queue/team-run'" src/` — should show zero matches (or only test imports, which we'll also clean).

**`agent-run.ts` runId restoration (3 sites in `handleStreamEvent`):**

Each of the three `db.insert(teamMessages).values({...})` calls in `handleStreamEvent` (the assistant_text_stop, tool_call, tool_result branches) currently OMITS `runId`. After the migration applies:
- For each, ADD `runId: isLead && leadRequestId ? leadRequestId : agentId,` to the values object.
- This matches the existing SSE-payload semantics already on lines 710, 832, etc.
- Update the comment at line 578-588 (the `leadRequestId` definition) — remove the `(NOT the team_messages.run_id column)` part because we ARE stamping it now. Keep the rationale paragraph; just update the parenthetical.

For teammates: `runId = agentId` (the teammate's own agent_runs.id) — groups all activity for that teammate run together. The admin page's primary view shows lead requests; teammate aggregations stay distinct via this fallback.

**Tests:** find the `enqueueTeamRun` mock in `src/app/api/onboarding/commit/__tests__/route.test.ts:75-77` AND `src/app/api/onboarding/commit/__tests__/route.test.ts:432`. Remove the mock declaration, the `vi.mock(...)` registration if it's solely for `enqueueTeamRun`, and the `expect(enqueueTeamRunMock).not.toHaveBeenCalled()` assertion (replace with a comment or remove if obvious).

Other test refs found by `grep -rn teamRuns src/ --include="*.test.ts"` — handle case-by-case. Most likely just delete dead mocks.

### Task 1 steps

- [ ] **Step 1: Pre-implementation grep + verify scope**

  - `grep -rn "teamRuns\b\|team_runs\b" src/ --include="*.ts"` — full reference set.
  - `grep -rn "enqueueTeamRun" src/ --include="*.ts"` — confirm zero non-test, non-doc-comment callers.
  - Read `drizzle/meta/_journal.json` to see the migration journal format.
  - Check what command generates Drizzle migrations: `cat package.json | grep -i drizzle`.

- [ ] **Step 2: Create the migration**

  Hand-write `drizzle/0016_drop_team_runs.sql` per the spec. If the project's drizzle-kit auto-generates these via `pnpm drizzle-kit generate`, run it and validate the output matches; if not, hand-write and update `drizzle/meta/_journal.json` + create a `drizzle/meta/0016_snapshot.json` based on the latest snapshot pattern.

- [ ] **Step 3: Update schema files**

  Apply the three schema changes (teamTasks.runId, teamMessages.runId, delete teamRuns block). Update the barrel.

- [ ] **Step 4: Delete dead code**

  Delete `src/lib/queue/team-run.ts`. Update tests that mocked `enqueueTeamRun`.

- [ ] **Step 5: Restore runId writes in agent-run.ts**

  Add `runId: isLead && leadRequestId ? leadRequestId : agentId,` to the 3 `team_messages` inserts in `handleStreamEvent`. Update the comment block at lines 578-588 to reflect the new state.

- [ ] **Step 6: Apply the migration locally**

  `pnpm drizzle-kit migrate` (or whatever the project script is — check package.json).
  Expected: applies cleanly. If your local DB had team_runs data, it's gone.

- [ ] **Step 7: Run vitest**

  `pnpm vitest run`
  Expected: full suite green. Some test mocks of `enqueueTeamRun` may need cleanup (you should have caught these in Step 4); fix any stragglers here.

- [ ] **Step 8: Type-check**

  `pnpm tsc --noEmit --pretty false`
  Expected: exit 0. (If `teamRuns` is still imported anywhere, this surfaces it.)

- [ ] **Step 9: Verify on the worktree branch**

  `git branch --show-current` — must start with `worktree-agent-`. If it says `dev`, run `git checkout -b worktree-agent-<id>` first.

- [ ] **Step 10: Commit**

  ```bash
  git add drizzle/0016_drop_team_runs.sql \
          drizzle/meta/ \
          src/lib/db/schema/team.ts \
          src/lib/db/schema/index.ts \
          src/workers/processors/agent-run.ts \
          src/app/api/onboarding/commit/__tests__/route.test.ts
  # also: any other test files that need cleanup
  git rm src/lib/queue/team-run.ts
  git commit -m "$(cat <<'EOF'
  chore(db): drop dead team_runs table + restore runId writes (Phase G cleanup)

  Phase E unified the lead/teammate runs under agent_runs. team_runs
  stopped getting written but the table + FKs lingered, causing the
  Task tool to crash with a stale FK violation when inserting team_tasks
  rows. Drop the FKs, drop the table, delete the dead enqueueTeamRun
  helper (zero production callers), and restore the runId writes to
  team_messages that were skipped because of the FK risk (commit
  comments at agent-run.ts:584 documented this workaround).

  After this commit, lead-side team_messages rows carry runId =
  leadRequestId (the user_prompt.id that woke the lead). This unlocks
  per-request aggregation in the /admin/team-runs pages — see Task 2
  of the plan for that migration.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

  Then `git log --oneline -1` to verify the commit landed on the worktree branch.

---

## Task 2: Admin pages per-request migration

**Files:**
- Modify: `src/app/(app)/admin/team-runs/page.tsx` — rewrite query to aggregate team_messages.
- Modify: `src/app/(app)/admin/team-runs/[runId]/page.tsx` — same migration.
- Modify or remove: any `__tests__` snapshots / unit tests for these pages.

### Task 2 spec

**`/admin/team-runs/page.tsx` (request list):**

Goal: one row per user_prompt request, sorted by `createdAt` desc, limit 100.

Query shape:
```ts
const requests = await db
  .select({
    requestId: teamMessages.id,
    teamId: teamMessages.teamId,
    teamName: teams.name,
    ownerEmail: users.email,
    goal: teamMessages.content,
    startedAt: teamMessages.createdAt,
    // aggregates — subqueries OR a self-join
    completedAt: sql<Date | null>`(
      SELECT max(created_at) FROM team_messages
      WHERE run_id = ${teamMessages.id} AND id != ${teamMessages.id}
    )`,
    totalTurns: sql<number>`(
      SELECT count(*)::int FROM team_messages
      WHERE run_id = ${teamMessages.id} AND type = 'agent_text'
    )`,
    // Status: derive from presence of terminal events. Heuristic:
    //   - if any tool_result has metadata.is_error=true → 'failed'
    //   - if there's an agent_text after the user_prompt → at least 'running'
    //   - if completedAt is recent (last 30s) → still 'running'
    //   - else 'completed'
    // Implementer judgment: pick the simplest correctness-preserving expression.
    // For v1, just compute "has any activity?" → 'running' if no, else 'completed'.
  })
  .from(teamMessages)
  .leftJoin(teams, eq(teams.id, teamMessages.teamId))
  .leftJoin(users, eq(users.id, teams.userId))
  .where(and(
    eq(teamMessages.type, 'user_prompt'),
    eq(teamMessages.messageType, 'message'),
    isNull(teamMessages.fromMemberId),
    isNotNull(teamMessages.toAgentId),
    // restrict to recent: last N days based on `sinceDays` param
    sinceDays !== null ? gte(teamMessages.createdAt, sinceClause) : undefined,
    // status filter (post-aggregation; see note below)
  ).filter(Boolean))
  .orderBy(desc(teamMessages.createdAt))
  .limit(100);
```

**Status filter:** the page currently supports `?status=running|completed|failed`. Since status is derived (not a column), filter post-aggregation in JS, OR rewrite as a CTE / lateral join. For v1, recommended path: drop the `status` filter param OR filter in JS after the query (less efficient but simpler).

**Drop columns from the page:** `trigger`, `totalCostUsd`. Show `—` or remove the columns from the UI table.

**Keep / preserve:** `ownerEmail` (user enhancement), `Trace` column displaying the requestId truncated (just like the user's recent enhancement).

**Update page heading + nav** — keep URL `/admin/team-runs` for stability (don't rename to `/admin/requests`). Update the heading copy to say something like "Recent requests" or "Per-request activity (post-Phase-E)" so it's clear what's being shown.

**`/admin/team-runs/[runId]/page.tsx` (single request detail):**

The `[runId]` URL parameter is now the user_prompt's `team_messages.id`.

Query 1: load the request (the user_prompt row itself):
```ts
const [request] = await db
  .select({
    requestId: teamMessages.id,
    teamId: teamMessages.teamId,
    teamName: teams.name,
    ownerEmail: users.email,
    goal: teamMessages.content,
    startedAt: teamMessages.createdAt,
    metadata: teamMessages.metadata,
  })
  .from(teamMessages)
  .leftJoin(teams, eq(teams.id, teamMessages.teamId))
  .leftJoin(users, eq(users.id, teams.userId))
  .where(eq(teamMessages.id, runId))
  .limit(1);
if (!request) notFound();
```

Query 2: load all activity for this request:
```ts
const activity = await db
  .select({...})
  .from(teamMessages)
  .where(eq(teamMessages.runId, runId))
  .orderBy(asc(teamMessages.createdAt));
```

Query 3: load team_tasks for this request:
```ts
const tasks = await db
  .select({...})
  .from(teamTasks)
  .where(eq(teamTasks.runId, runId))
  .orderBy(asc(teamTasks.startedAt));
```

The detail page UI structure stays similar to today (header / per-task breakdown / message timeline). Just rewires the queries and field names.

### Task 2 steps

- [ ] **Step 1: Read the user's recent admin commits**

  `git log -p --since="2 days ago" -- 'src/app/(app)/admin/team-runs/'`
  Understand what enhancements the user shipped (ownerEmail, traceId, etc.) so the migration preserves them.

- [ ] **Step 2: Migrate the list page**

  Rewrite `/admin/team-runs/page.tsx` per the spec. Drop `trigger` / `totalCostUsd` UI columns. Update heading copy. Keep ownerEmail / Trace columns.

- [ ] **Step 3: Migrate the detail page**

  Rewrite `/admin/team-runs/[runId]/page.tsx` per the spec. Three queries: request header, activity timeline, team_tasks breakdown.

- [ ] **Step 4: Manual smoke test**

  Start the dev server (`pnpm dev`), log in as an admin, navigate to `/admin/team-runs`. Verify:
  - Request list renders without errors
  - Click a row → detail page loads
  - Detail page shows the user_prompt, the agent_text response(s), tool_call/tool_result rows, team_tasks breakdown
  - ownerEmail column populated
  - Filters that survived (`?teamId=`, `?sinceDays=`) work; dropped filters (`?status=`, `?minCost=`) gracefully ignored

- [ ] **Step 5: Run lint/typecheck/test**

  `pnpm lint && pnpm tsc --noEmit --pretty false && pnpm vitest run`
  Expected: green. Note: there are 3 pre-existing `react-hooks/set-state-in-effect` errors in team UI files that would block the lint hook on commit. Filter your output to ignore them OR fix them (out-of-scope but a separate small follow-up).

- [ ] **Step 6: Commit on the worktree branch**

  Verify branch first: `git branch --show-current` must start with `worktree-agent-`.

  ```bash
  git add 'src/app/(app)/admin/team-runs/'
  git commit -m "$(cat <<'EOF'
  refactor(admin): migrate /admin/team-runs to per-request view (Phase G follow-up)

  team_runs is dropped; the new "request" anchor is the user_prompt
  team_messages row. Rewrite the list to aggregate activity by runId
  (which post-Phase-E equals the user_prompt.id, restored to be written
  in the same PR). Detail page loads request header + activity timeline
  + team_tasks breakdown.

  Drops:
  - trigger column (no equivalent post-Phase-E)
  - totalCostUsd column (no per-message cost tracking; cost lives on
    agent_runs.totalTokens at the agent level)
  - status / minCost filters (status is derived, not a column;
    re-implement post-aggregation if needed)

  Preserves recent enhancements:
  - ownerEmail column (joined via teams.userId → users.email)
  - Trace column showing the truncated requestId

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Self-review checklist

- [x] Migration sequenced safely (drop FKs first, then drop table) — guards against stuck state.
- [x] Schema column comments updated to explain the post-Phase-G semantics (no FK, just a grouping handle).
- [x] Worktree-branch reminder repeated at start of EACH task — prior implementers committed on dev twice.
- [x] Per-request granularity preserved (the user's explicit ask) — request = user_prompt; aggregation by runId.
- [x] User's recent admin enhancements (ownerEmail, Trace) explicitly preserved.
- [x] Build gate (`pnpm tsc --noEmit --pretty false`) explicit.
- [x] Out-of-scope items called out: pre-existing UI lint errors (3 react-hooks/set-state-in-effect) flagged but not in scope.
- [x] Documented dropped UI columns (`trigger`, `totalCostUsd`) so the user isn't surprised.
- [x] Detail page query model documented (3 queries, not over-joined).
- [x] Old data behavior documented (rows with NULL runId pre-PR don't appear in admin views).
