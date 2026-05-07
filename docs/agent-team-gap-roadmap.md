# Agent Team Gap Closure Roadmap

> Scope: bring ShipFlare's multi-agent runtime closer to Claude Code engine's
> agent-team primitives. Assumes the three 2026-05-04 collapse plans
> (`merge-judging-and-share-slop-rules`, `pipeline-to-tools`,
> `collapse-to-social-media-manager`) have shipped — only `coordinator` (lead)
> + `social-media-manager` (member) remain.

## Method

Every Tier-1 / Tier-2 / Tier-3 gap from the engine analysis gets a row.
Each row has a **plan link** — either a **full plan** (bite-sized TDD steps,
ready to execute) or a **stub plan** (scoped intent doc; full plan generated
on demand). Where I disagree with closing a gap, the row's stub plan body
makes the case so the founder can override.

**Priority codes:**
- **P0** — do next; full plan ready
- **P1** — do soon; stub written, waiting for go-ahead
- **P2** — do later; stub written, low urgency
- **P3** — argue against, stub explains why; only do if founder overrides

## Gap status

| # | Gap | Engine source | ShipFlare state | Priority | Plan |
|---|---|---|---|---|---|
| 1 | **AskUserQuestion** — agent → founder structured Q | `engine/tools/AskUserQuestionTool/` | absent | P0 (full) | [`2026-05-04-ask-user-question-tool.md`](superpowers/plans/2026-05-04-ask-user-question-tool.md) |
| 2 | **write_memory_log** — agent learns across runs | `engine/tools/AgentTool/agentMemory.ts` | partial: `agent_memories` table + `MemoryStore.appendLog()` exist; only `read_memory` tool exposed | P0 (full) | [`2026-05-04-write-memory-log-tool.md`](superpowers/plans/2026-05-04-write-memory-log-tool.md) |
| 3 | **plan_approval_request** initiation | `engine/tools/SendMessageTool/prompt.ts` protocol block | partial: response dispatcher exists; no request-side, no UI | P0 (full) | [`2026-05-04-plan-approval-request.md`](superpowers/plans/2026-05-04-plan-approval-request.md) |
| 4 | **SendMessage broadcast `to: "*"`** | `engine/tools/SendMessageTool/prompt.ts:14` | **shipped** ([`dispatchBroadcast`](../src/tools/SendMessageTool/SendMessageTool.ts#L593)) with rate-limit | done | — |
| 5 | **shutdown_request / shutdown_response** | engine SendMessage protocol | **shipped** | done | — |
| 6 | **Shared TaskList (TaskCreate / TaskUpdate / TaskGet / TaskOutput)** — teammates self-claim | `engine/tools/TaskCreateTool/`, `~/.claude/tasks/{team}/` | absent (team_tasks is spawn-record only) | P1 (stub) | [`2026-05-04-shared-tasklist.md`](superpowers/plans/2026-05-04-shared-tasklist.md) |
| 7 | **TodoWrite per agent** | engine TodoWriteTool | absent | P2 (stub) | [`2026-05-04-todowrite-per-agent.md`](superpowers/plans/2026-05-04-todowrite-per-agent.md) |
| 8 | **Per-agent memory namespace** (per-`agentDefName` scope) | `engine/tools/AgentTool/agentMemory.ts` + `agentMemorySnapshot.ts` | shared `(userId, productId)` scope today | P3 (stub argues against) | [`2026-05-04-per-agent-memory-namespace.md`](superpowers/plans/2026-05-04-per-agent-memory-namespace.md) |
| 9 | **TeamCreate / TeamDelete** dynamic teams | `engine/tools/TeamCreateTool/`, `TeamDeleteTool/` | absent | P3 (stub argues against) | [`2026-05-04-team-create-delete.md`](superpowers/plans/2026-05-04-team-create-delete.md) |
| 10 | **ScheduleCronTool** — agent self-schedules cron | `engine/tools/ScheduleCronTool/` | absent | P3 (stub argues against) | [`2026-05-04-schedule-cron-tool.md`](superpowers/plans/2026-05-04-schedule-cron-tool.md) |
| 11 | **RemoteTrigger / push notifications** — agent → founder push | `engine/tools/RemoteTriggerTool/` | absent | P1 (stub) | [`2026-05-04-remote-trigger-push.md`](superpowers/plans/2026-05-04-remote-trigger-push.md) |
| 12 | **SkillTool dynamic 1% context budget** — runtime skill listing | `engine/tools/SkillTool/prompt.ts` | shipped SkillTool but static `_catalog.ts` listing | P2 (stub) | [`2026-05-04-skilltool-dynamic-budget.md`](superpowers/plans/2026-05-04-skilltool-dynamic-budget.md) |
| 13 | **Built-in `Explore` / `Plan` / `general-purpose` agents** | `engine/tools/AgentTool/built-in/` | absent | P2 (stub) | [`2026-05-04-builtin-research-agents.md`](superpowers/plans/2026-05-04-builtin-research-agents.md) |
| 14 | **Founder→lead message-only model** (drop `/api/automation/run`) | engine: founder messages are the only wake source for the lead | partial: CLAUDE.md declares it but `/api/automation/run` still parallel | P1 (stub) | [`2026-05-04-drop-api-automation-run.md`](superpowers/plans/2026-05-04-drop-api-automation-run.md) |
| 15 | **Sync cancel** (engine `abortController`) vs eventually-consistent | engine `engine/tools/AgentTool/runAgent.ts` AbortController | declared design choice in CLAUDE.md "Founder UI mental model" | architecture choice — **no plan** | — |
| 16 | **In-process teammate** (AsyncLocalStorage) vs BullMQ cross-process | `engine/tasks/InProcessTeammateTask/` | hosted-architecture choice | architecture choice — **no plan** | — |
| 17 | **Per-teammate UX**: spinner verb, pillLabel, zoomed transcript, Companion sprite | `engine/tasks/InProcessTeammateTask/types.ts:60-66`, `engine/buddy/CompanionSprite.tsx` | partial: status pill + agent detail page exist; no spinner verbs / sprite | P2 (stub) | [`2026-05-04-teammate-ux-polish.md`](superpowers/plans/2026-05-04-teammate-ux-polish.md) |

## Sequencing

**P0 (recommended order, all full plans ready):**
1. AskUserQuestion (#1) — biggest visible UX win; exercises question/answer/wake loop
2. write_memory_log (#2) — tiny (1 day); unblocks social-media-manager learning
3. plan_approval_request (#3) — completes approval primitive; reuses #1's pattern

**P1 (do after P0, in any order — pick by founder need):**
- #6 shared TaskList (most architectural; biggest unlock for Tier-2 agents)
- #11 RemoteTrigger / push (highest founder-visibility win)
- #14 drop `/api/automation/run` (cleanest architectural reduction)

**P2 (do later, in any order):**
- #7 TodoWrite per agent
- #12 SkillTool dynamic budget
- #13 built-in research agents
- #17 teammate UX polish

**P3 (I argue against; stub explains; founder can override):**
- #8 per-agent memory namespace
- #9 TeamCreate / TeamDelete
- #10 ScheduleCronTool

## Architecture choices NOT planned

#15 (sync cancel) and #16 (in-process teammate) are explicit **design choices**,
not gaps. ShipFlare's hosted, multi-tenant, BullMQ-backed shape genuinely
needs eventually-consistent cancel and out-of-process teammates. Closing
these "gaps" would regress the architecture, not improve it. CLAUDE.md
"Founder UI mental model" already documents both.

## How to use this doc

1. Skim the table — every gap has a plan link.
2. Pick a row. Read its plan.
3. If it's a P0 full plan, hand to the executor (subagent or human).
4. If it's a P1/P2 stub, decide whether to commit. If yes, ask for the
   full bite-sized version: "flesh out the shared TaskList plan."
5. If it's a P3 stub, decide if my argument-against holds. If you want
   to override, ask: "expand the per-agent memory plan; ignore my objection."

The roadmap is the master tracker. Individual plans are the contract.
