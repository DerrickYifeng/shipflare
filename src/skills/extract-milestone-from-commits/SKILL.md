---
name: extract-milestone-from-commits
description: Pick the single highest-signal milestone from a window of git activity, or null when only chore.
context: fork
agent: extract-milestone-from-commits
model: claude-haiku-4-5-20251001
maxTurns: 1
cache-safe: true
output-schema: extractMilestoneOutputSchema
allowed-tools: []
references:
  - ./references/commit-signal-patterns.md
---

# extract-milestone-from-commits

Reads a window of commits / PRs / releases and returns ONE milestone —
the highest-signal change a reader (not a code reviewer) would care
about. Returns `{ milestone: null }` when the window is chore-only.

The tactical planner feeds this into the thesis pass — a fresh ship
story is usually the best thesis anchor; a chore-only week falls back to
a `top_reply_ratio` thesis instead.

## Input

See agent prompt. `entries` typically 5-50 rows, drawn from the past
7-14 days via `git log --oneline --since` + GitHub PR + release data.

## Output

See `extractMilestoneOutputSchema`.

## Why null is valid

Most weeks ship real work, but some don't — founder was traveling, shipped
tests / refactors, handling a support incident. A forced milestone turns
into marketing theatre. Returning null lets the planner route to a
non-ship thesis without emitting a false positive.
