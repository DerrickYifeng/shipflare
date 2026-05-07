# Shared TaskList (Stub Plan)

> **Stub plan** — scoped intent. Ask "flesh out shared-tasklist plan" to expand into bite-sized TDD steps.
> Status: P1 (do soon, post-P0). Roadmap: [`docs/agent-team-gap-roadmap.md`](../../agent-team-gap-roadmap.md) row #6.

## Goal

Give every teammate a **shared, claimable task list** — engine model where any teammate can `TaskList()` to see open work, `TaskUpdate({owner: 'me'})` to claim, then `TaskUpdate({status: 'completed'})` when done. Replaces today's "lead always assigns via SendMessage" pattern with "lead seeds the queue, teammates self-pull."

Highest payoff once Tier-2 agents (PMM, SEO Manager, Content Marketing Manager) join — at that point the lead becomes a bottleneck. Building the primitive now means Tier-2 onboarding is a config change, not an architectural one.

## Architecture

1. **Reuse `team_tasks` table.** Already exists ([`src/lib/db/schema/team.ts:236`](../../../src/lib/db/schema/team.ts#L236)). Today it's spawn-records-only; extend it with `owner_member_id` (nullable; null = unclaimed) + `priority: int` + `blocked_by_task_id` (nullable, self-FK for dependencies).
2. **4 new tools**: `TaskCreate`, `TaskList`, `TaskUpdate`, `TaskGet`. (Skip `TaskOutput` — engine has it for output streaming; we already stream via SSE.) All are deferred tools registered in `registry-team.ts`.
3. **Routing rule**: `TaskCreate` requires team-run context; tasks are scoped to `teamId`. `TaskUpdate` lets any caller in the team mutate (engine model — no per-row ACL beyond team scope).
4. **Lead-vs-member**: both can call all four tools. The pattern emerges naturally — lead seeds with `owner=null`, teammates claim by setting `owner=self.memberId`.
5. **Coordinator's daily playbook updates**: instead of "spawn social-media-manager with a discrete prompt", lead does "create N tasks, broadcast 'task list refreshed', sleep". Members wake on broadcast, claim, work, mark done, log to memory, sleep.

## File map

**Created**
- `src/tools/TaskCreateTool/TaskCreateTool.ts` + tests
- `src/tools/TaskListTool/TaskListTool.ts` + tests
- `src/tools/TaskUpdateTool/TaskUpdateTool.ts` + tests
- `src/tools/TaskGetTool/TaskGetTool.ts` + tests
- `drizzle/0020_team_tasks_claimable.sql` — add `owner_member_id`, `priority`, `blocked_by_task_id`
- `e2e/shared-tasklist-smoke.spec.ts`
- `src/app/(app)/team/_components/task-list-panel.tsx` — founder-visible panel

**Modified**
- `src/lib/db/schema/team.ts` (add 3 columns to teamTasks)
- `src/tools/registry-team.ts` (register 4 tools)
- `src/tools/AgentTool/agents/coordinator/AGENT.md` (rewrite daily playbook to seed tasks instead of direct-spawn)
- `src/tools/AgentTool/agents/social-media-manager/AGENT.md` (add the 4 tools + "claim-then-work" pattern)
- `src/tools/AgentTool/agents/social-media-manager/references/patterns-and-examples.md` (one new pattern: claim-then-work)
- `src/app/(app)/team/page.tsx` (mount task-list-panel)
- `CLAUDE.md` (note shared TaskList primitive + ownership model)

## Tasks (high-level)

1. **DB migration** — add `owner_member_id` (FK, nullable), `priority` (int, default 0), `blocked_by_task_id` (self-FK, nullable). Backfill existing rows: `owner_member_id = member_id`, `priority = 0`. (~80 lines + 1 SQL file.)
2. **TaskCreate tool** — input `{description, prompt?, priority?, blockedBy?}`. Inserts row with `owner=null`, `status='queued'`. Returns `{taskId}`. (~200 lines + tests.)
3. **TaskList tool** — input `{filter: 'unclaimed' | 'mine' | 'all', limit?}`. Returns array of `{taskId, description, status, owner, priority, blockedBy}`. Default filter is `unclaimed AND not blocked`. (~150 lines + tests.)
4. **TaskUpdate tool** — input `{taskId, owner?, status?, output?, errorMessage?}`. Single tool covers claim (set owner), complete (set status), fail (set status + errorMessage), unblock (set blockedBy=null). Validates state transitions. (~250 lines + tests.)
5. **TaskGet tool** — input `{taskId}`. Returns full row. Trivial. (~80 lines + tests.)
6. **Register all 4** in `registry-team.ts`. (~10 lines.)
7. **Update coordinator's daily playbook** to seed tasks instead of direct-spawning. New pattern: `TaskCreate × N`, `SendMessage to:"*" "tasks ready"`, end turn. (~50 lines AGENT.md edit.)
8. **Update social-media-manager** with claim-then-work pattern. AGENT.md adds 4 tools to allow-list; references add a "claim-then-work" pattern showing the loop. (~80 lines.)
9. **TaskListPanel UI** — founder-visible right-rail panel showing all tasks for the active team, with status badges, owner pills, blocked-by chains. Read-only initially; founder mutations via SendMessage to coordinator. (~300 lines.)
10. **Real-browser smoke** — seed 3 tasks via the test endpoint; verify panel renders; verify (via DB) that `social-media-manager` claimed and completed at least one when triggered. (~100 lines spec.)
11. **CLAUDE.md note** — document the shared-list primitive, ownership rule, and "lead seeds, members claim" pattern.

## Tradeoffs / risks

- **Lock contention on claim.** Two teammates calling `TaskUpdate({owner: self})` on the same row at the same instant could double-claim. Mitigation: optimistic concurrency via a `version` int column + conditional UPDATE; if second update sees mismatched version, it returns "already claimed" and the loser tries the next task.
- **Blocked-by graph cycles.** With self-FK + agent-set `blockedBy`, an agent could create a cycle. Validate at insert time (no inserting a task whose `blockedBy` chain reaches the new task's id).
- **Shared list invites churn.** Engine sees agents constantly polling. Mitigation: `TaskList` subscribes to a team-wide Redis pub/sub key `team:${teamId}:tasks`; agents listen between turns rather than re-polling.
- **Dependency on Tier-2 to justify the spend.** With only social-media-manager claiming, the queue is degenerate. Plan ships infra; real value lands when PMM/SEO arrive. Acceptable — building it now is cheaper than retrofitting after the team shape changes.
- **Founder loses single-pane visibility.** Today the conversation thread shows the lead's prose as the source of truth. With self-claim, teammates work without the lead announcing. Mitigation: TaskListPanel surfaces the queue + state changes in a sidebar; SSE broadcasts each `TaskUpdate` so the panel auto-refreshes.

## Estimate

5–7 days for one engineer with deep shipflare context. Mostly DB migration + 4 small tools + UI panel; agent-side patterns are short references.

## When to flesh out

After all P0 plans land. If a Tier-2 agent (PMM/SEO/CMM) is being scoped, do this first — onboarding the new agent without TaskList means re-wiring lead's playbook every time.
