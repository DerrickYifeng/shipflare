# TodoWrite per Agent (Stub Plan)

> **Stub plan** — scoped intent. Ask "flesh out todowrite-per-agent plan" to expand into bite-sized TDD steps.
> Status: P2 (do later). Roadmap: [`docs/agent-team-gap-roadmap.md`](../../agent-team-gap-roadmap.md) row #7.

## Goal

Give every agent a **per-run scratch todo list** — engine pattern where the agent uses TodoWrite to plan its own multi-step work and tick items off as it progresses. Distinct from `team_tasks` (cross-agent shared queue) and `plan_items` (founder-level marketing plan): this is **the agent's own working memory for one turn-loop**.

Closes Tier-1 gap #7. Lower priority because at 2-agent scale, our agents already mostly use plain prose for self-planning.

## Architecture

1. **New table `agent_todos`**: `(id, agentRunId FK, position int, content text, status text, createdAt, updatedAt)`. Scoped per `agent_runs.id` — todos die when the run completes.
2. **TodoWrite tool**: input `{todos: Array<{content, status: 'pending' | 'in_progress' | 'completed'}>}`. Replaces the entire list each call (engine semantic — agents send the full list every turn). Tool returns `{todos: <updated full list>}`.
3. **TodoRead tool**: trivial; returns the current list. Only needed if we want self-querying outside TodoWrite's return value (engine doesn't have a separate Read).
4. **Mailbox-drain integration**: when agent resumes from sleep, the todo list is loaded into the system prompt as `<agent-todos>` so it remembers what it was doing pre-sleep.
5. **UI surfacing**: agent-detail page (`src/app/(app)/team/[memberId]/page.tsx`) gains a "Current todos" subsection showing the latest list. Helps founder debug stuck agents.

## File map

**Created**
- `src/tools/TodoWriteTool/TodoWriteTool.ts` + tests
- `drizzle/0021_agent_todos.sql`
- `src/lib/db/schema/agent-todos.ts`
- `src/app/(app)/team/[memberId]/_components/current-todos.tsx`
- `e2e/todowrite-smoke.spec.ts`

**Modified**
- `src/lib/db/schema/index.ts` (export agent_todos)
- `src/tools/registry-team.ts` (register TodoWriteTool)
- `src/tools/AgentTool/agents/coordinator/AGENT.md` (add TodoWrite to tools + "use it for multi-step plans" hint)
- `src/tools/AgentTool/agents/social-media-manager/AGENT.md` (add TodoWrite to tools + reference)
- `src/workers/processors/agent-run.ts` (load `<agent-todos>` into system prompt on resume)
- `src/lib/team/system-prompt-context.ts` (substitute `{AGENT_TODOS}` placeholder)
- `CLAUDE.md` (note TodoWrite primitive, scope, lifecycle)

## Tasks (high-level)

1. DB migration — `agent_todos` table with FK cascade on `agent_runs.id` delete.
2. TodoWriteTool implementation — replace-list semantics, validates status enum, deletes-then-inserts inside one transaction.
3. Register tool.
4. System-prompt context loader — fetch latest todos for the run, inject as `<agent-todos>` block.
5. Update both AGENT.mds — add tool + 1 reference example showing "plan in 3 todos, tick as you go."
6. Agent-detail UI subsection — list current todos with status badges.
7. Real-browser smoke — trigger a multi-step coordinator scenario, verify todos appear in panel and update across turns.

## Tradeoffs / risks

- **Overlap with `plan_items`** — easy for the agent to confuse "this is a founder-facing plan_item" vs "this is my private todo." Mitigation: the references make the distinction explicit + the prompt for TodoWrite explicitly says "private working memory; use add_plan_item for founder-facing work."
- **Replace-list semantics is bandwidth-heavy.** Engine sends the full list every call (~1-3KB). Acceptable at our scale; revisit if it becomes a hot path.
- **At 2-agent scale, may be unused.** Coordinator and social-media-manager both have short turn-loops. Tool ships; if metrics show <1 call per run after a month, consider dropping it.
- **System-prompt cache busting.** Loading `<agent-todos>` into the system prompt means cache invalidation every time the list changes. Mitigation: put `<agent-todos>` in the **last** system block (engine pattern); only that suffix gets recomputed.

## Estimate

2–3 days. Mostly trivial tool + small UI.

## When to flesh out

When the coordinator needs to track 5+ steps within a single founder-facing turn. Today its flows fit in prose. Trigger: founder reports "the coordinator forgot half its plan" — that's the signal.
