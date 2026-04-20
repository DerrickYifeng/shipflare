---
name: build-launch-runsheet
description: Produce the launch-day runsheet. Each beat becomes a plan_items row.
context: fork
agent: build-launch-runsheet
model: claude-sonnet-4-6
maxTurns: 1
cache-safe: true
output-schema: launchRunsheetOutputSchema
allowed-tools: []
references:
  - ./references/runsheet-template.md
---

# build-launch-runsheet

Emits the hourly run-of-show for one launch day. Each beat is convertible
to a `plan_items.kind='runsheet_beat'` row; ~half reference another atomic
skill (`skillName`) that the dispatcher will chain into when the plan item
reaches `executing`. The remaining beats are manual actions the founder
performs — check the dashboard, thank top supporters, draft the retro
outline.

## Input

See agent prompt. Critical inputs:
- `launchDate` + `launchTimezone` anchor T-0.
- `channels` filter — the agent will not schedule beats on surfaces the
  founder isn't on.
- `assets.*Ready` flags ensure prep beats get inserted before T-0 when an
  asset isn't ready.

## Output

See `launchRunsheetOutputSchema`. `beats[]` ≥ 6, typically 12-20.

## When to run

- Scheduled as a `launch_asset` plan_item in the `momentum` phase, T-2 to
  T-1 days.
- Re-run allowed if the founder adjusts `launchDate` (strategic replan).

## Why hourly, not daily

Launch day collapses onto a ~12h window. A daily granularity loses the
"did I thank the hunter in time" / "did I send the waitlist email before
the algorithm chilled" questions. An hourly runsheet converts the chaotic
day into a predictable execution queue.
