# ScheduleCronTool (Stub Plan — Argues Against)

> **Stub plan** — scoped intent. Status: **P3 (I argue against)**. Roadmap row #10.
> Override with: "expand schedule-cron-tool plan; ignore my objection."

## Goal (if we did this)

Let an agent self-register a future wake-up: "wake me Monday 9am with prompt X." Engine has `ScheduleCronTool` for this. Today, all wake schedules in shipflare are statically registered BullMQ jobs (`daily-run-fanout`, `weekly-replan`, etc.).

## Why I argue against

1. **Sleep + wake covers most cases.** An agent that wants to do "ask in 5 minutes if anything happened" calls `Sleep({duration_ms: 300_000})`. Engine's cron tool covers "wake at 9am on weekdays" — that's a different shape, but for our marketing surface, agents don't need it.
2. **BullMQ static cron is the right shape for SaaS.** The jobs we'd schedule from agents (daily run, weekly replan) ARE the founder-level cadence — they should be code, not LLM-controlled. Letting agents register cron means the agent could DDoS itself ("cron every minute") or forget a job (no GC).
3. **Founder has no visibility / control.** Static cron is in `src/lib/queue/`; agent-registered cron is in DB rows. To pause a stuck schedule, founder would need a UI (which doesn't exist) or DB access.
4. **The actual gap is "scheduled founder follow-up," not agent-cron.** If the founder wants "remind me Monday to check", that's a calendar feature; if the coordinator wants "check back in an hour", that's `Sleep`. Neither needs a full cron tool.

## What the plan would look like (if greenlit)

### Architecture

1. **New table `agent_schedules`**: `(id, teamId, ownerAgentId, cronExpression, prompt, nextRunAt, createdAt, lastRunAt, enabled)`.
2. **New tools**: `ScheduleCron({cron, prompt})` returns `{scheduleId}`. `ScheduleList()` returns active schedules. `ScheduleCancel({scheduleId})`.
3. **New BullMQ processor** `agent-schedule-tick.ts`: every minute, queries `agent_schedules` for `nextRunAt <= now()`, sends a SendMessage to the owner agent with `prompt`, updates `nextRunAt` to next cron tick.
4. **UI**: /team page sidebar gets a "Schedules" panel showing the agent's pending wakes.

### File map

- Create: `drizzle/0024_agent_schedules.sql`
- Create: `src/lib/db/schema/agent-schedules.ts`
- Create: `src/tools/ScheduleCronTool/` (3 tools — Create / List / Cancel + tests)
- Create: `src/workers/processors/agent-schedule-tick.ts`
- Create: `src/lib/queue/agent-schedule-tick.ts` (BullMQ static cron @ */1 * * * *)
- Modify: registry-team.ts, both AGENT.mds, CLAUDE.md

### Tasks (high-level)

1. Migration.
2. Three tools.
3. Processor that fires schedules.
4. Per-team rate-limit (max 5 active schedules per team — prevent fan-out).
5. UI panel.
6. Smoke.

## Tradeoffs / risks (assuming we do it)

- **Foot-gun**: agent registers `cron: '* * * * *'` (every minute). Mitigation: validate cron expression to require minimum 5-minute interval.
- **Orphan schedules**: agent dies; schedule keeps firing into a dead `agent_runs.id`. Mitigation: GC on processor side (skip if owner run is `completed` / `killed`).
- **Quota math**: scheduled wakes count against the team's weekly budget. Need to subtract them upfront. Currently budget is by-call; would need to add scheduled-call accounting.

## My recommendation

**Don't do this.** Use `Sleep` for short waits + static BullMQ cron for everything cadenced. Agents shouldn't own their wake schedule — that's product/founder territory.

## If you override

- Confirm by saying: "expand schedule-cron-tool plan; I want agent-driven cron."
- I'll generate the full TDD plan. Estimate: 4–5 days.
