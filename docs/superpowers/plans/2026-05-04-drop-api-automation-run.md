# Drop /api/automation/run — Founder→Lead Message-Only Model (Stub Plan)

> **Stub plan** — scoped intent. Ask "flesh out drop-api-automation-run plan" to expand into bite-sized TDD steps.
> Status: P1 (do soon). Roadmap row #14.

## Goal

Remove `/api/automation/run` (and the `Run today` button that calls it) and route the founder-triggered "run" through the same `POST /api/team/conversations/[id]/messages` path that conversational founder messages use. Brings the runtime fully into the engine's mental model: **the lead is always sleeping; founder messages are the only wake source**.

## Why

CLAUDE.md "Founder UI mental model" says:
> The team-lead is **always present** as a sleeping `agent_runs` row. Founders don't "start runs" — they send messages to the lead.

But `/api/automation/run` violates this — it kicks off a fresh full-scan workflow as a parallel codepath. Two ways to start work = two state machines to maintain, two surfaces for race conditions, founder confusion ("Run today" vs "send a message").

After this plan: ONE codepath. Less code, cleaner mental model, easier to reason about lead lifecycle.

## Architecture

1. **The "Run today" button becomes a deterministic founder message.** Clicking it POSTs `"Run today's full scan."` to `POST /api/team/conversations/[id]/messages` (existing endpoint). Coordinator wakes, reads the message, recognizes the trigger phrase (or uses a magic prefix `/run-today` for unambiguity), and runs its daily playbook.
2. **Delete `src/app/api/automation/run/route.ts`** and any code path that schedules `processFullScan` directly.
3. **The daily BullMQ cron** (currently `daily-run-fanout`) becomes "send a system message to each user's coordinator." It POSTs the same `/run-today` message via the conversation message endpoint (or directly via DB insert + wake — same effect).
4. **No new tools, no new schema.** Pure refactor — moves trigger from API call to founder-message-style insertion.

## File map

**Deleted**
- `src/app/api/automation/run/route.ts`
- (any direct callers of `processFullScan` outside the agent-run worker — grep first)

**Modified**
- Component that owns the `Run today` button — change `onClick` from `fetch('/api/automation/run')` to `fetch('/api/team/conversations/[id]/messages', {body: '/run-today'})`
- `src/workers/processors/daily-run-fanout.ts` — change job body from "spawn a run" to "insert a founder message into each user's most-recent conversation + wake the coordinator"
- `src/tools/AgentTool/agents/coordinator/AGENT.md` — recognize `/run-today` (or the literal `Run today's full scan.`) as the daily playbook trigger
- `e2e/daily-run-smoke.spec.ts` (if exists) — update to use the new message-trigger path
- `CLAUDE.md` — flip "founder UI mental model" from "declared but partial" to "fully consistent"

## Tasks (high-level)

1. Grep all callers of `/api/automation/run` and `processFullScan`. Map each to the new path.
2. Update the daily-run-fanout cron to insert messages instead of starting runs.
3. Update the `Run today` button.
4. Coordinator AGENT.md — teach it to recognize the trigger, gate via `query_plan_items` to confirm there's slot work, then run normal daily flow.
5. Delete `/api/automation/run` route + unused processor scaffolding.
6. Update existing E2E tests.
7. Manual check: click `Run today`, observe coordinator wake, observe normal daily flow.

## Tradeoffs / risks

- **Trigger phrase brittleness.** If coordinator's prompt doesn't recognize `/run-today` (typos, prompt drift), the daily run silently no-ops. Mitigation: use a structured marker — message metadata `{"trigger": "daily_run"}` rather than text matching. Coordinator's drain reads metadata, not just content.
- **Backward compat.** Any external integrations (Zapier, Make.com, custom curl) hitting `/api/automation/run` will break. Mitigation: keep the route alive as a thin shim that POSTs the message internally, log a deprecation warning, set a sunset date 60 days out.
- **Multi-conversation ambiguity.** Founder may have 3+ active conversations. Which one does the cron post into? Pick "most recent" by default; let the founder pin a "primary" conversation in settings later.
- **Subtle state-machine difference.** Old: API → BullMQ job → fresh agent_run row. New: insert message → wake existing agent_run. The "fresh row" used to give a clean slate; now the coordinator carries history. Acceptable — that's the engine model.

## Estimate

2–3 days. Mostly grep-and-replace with a careful test sweep.

## When to flesh out

After all P0 plans land. Doing this earlier risks conflicting with the AskUserQuestion / plan_approval_request flows that depend on the conversation-message path being stable.
