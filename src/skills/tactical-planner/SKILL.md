---
name: tactical-planner
description: Read the active strategic path + weekly signals; produce concrete plan_items for the next 7 days.
context: fork
agent: tactical-planner
model: claude-haiku-4-5-20251001
maxTurns: 2
cache-safe: false
output-schema: tacticalPlanSchema
allowed-tools: []
references:
  - ./references/angle-playbook.md
  - ./references/phase-task-templates.md
  - ./references/skill-catalog.md
  - ./references/voice-profile.md
---

# tactical-planner

One LLM call per week, per user. Runs at three moments:

1. **Onboarding commit** — the first week's tactical plan, right after
   the strategic path lands.
2. **Monday 00:00 UTC cron** — weekly re-plan for every active user.
3. **Manual re-plan** — `POST /api/plan/replan` (Phase 8), when the
   founder clicks "Re-plan this week".

## Input

See agent prompt. The skill-runner injects `skillCatalog` automatically
at runtime (`src/skills/_catalog.ts` exported as markdown via
`references/skill-catalog.md`).

## Output

See `tacticalPlanSchema`. Items land in `plan_items`; the `plan.notes`
text is surfaced in the founder's Today header for the week.

## Cache disabled

`cache-safe: false` — every user's input is unique enough that cache
hits are negligible. Haiku 4.5 is cheap enough to run uncached.

## Replan behaviour (Phase 7)

The dispatcher marks items whose phase no longer matches `derivePhase()`
as `stale` when a phase boundary crosses mid-week. The tactical planner
on the next run treats stale items the same as completed ones for
dedupe purposes.
