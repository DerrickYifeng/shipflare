---
name: draft-launch-day-comment
description: Draft the maker's first pinned comment for one Product Hunt launch day.
context: fork
agent: draft-launch-day-comment
model: claude-sonnet-4-6
maxTurns: 1
cache-safe: true
output-schema: draftLaunchDayCommentOutputSchema
allowed-tools: []
references:
  - ./references/first-comment-anatomy.md
---

# draft-launch-day-comment

Writes the first comment the maker will pin at the top of their Product
Hunt launch-day thread. One invocation per launch. Emits the comment text
and the hook pattern used (`origin_story` / `problem_statement` /
`contrarian_claim` / `vulnerable_confession`) so the planner can dedupe
across surface rewrites.

## Input

See agent prompt.

## Output

See `draftLaunchDayCommentOutputSchema`.

## When to run

- Scheduled as a `launch_asset` plan_item in the `momentum` phase, typically
  T-1 day.
- Re-run allowed if the user edits `founder.why` or adds a
  `launchContext.firstMetric` after the first draft.
