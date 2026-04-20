---
name: analytics-summarize
description: Replace the old analyst agent. Produce a weekly analytics summary + structured numbers + recommended next moves.
context: fork
agent: analytics-summarize
model: claude-sonnet-4-6
maxTurns: 1
cache-safe: true
output-schema: analyticsSummarizeOutputSchema
allowed-tools: []
references:
  - ./references/signal-vs-noise.md
---

# analytics-summarize

Replacement for the retired compound `analyst` agent. One LLM call per
week, per user. Consumes raw metrics + prior-period numbers; emits a
`headline`, a plain-English `summaryMd`, structured `metrics`,
`highlights` + `lowlights` arrays, and `recommendedNextMoves` the
tactical planner can schedule.

## Input

See agent prompt.

## Output

See `analyticsSummarizeOutputSchema`.

## When to run

- Sunday night weekly cron — Phase 7 worker.
- Also on-demand when the founder hits "recap" in Today.
- Output is written to a `plan_items.kind='analytics_summary'` row and
  the structured `metrics` power the Today header tiles.
