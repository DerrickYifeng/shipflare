---
name: identify-top-supporters
description: Rank up to 30 accounts by meaningful engagement within a period.
context: fork
agent: identify-top-supporters
model: claude-haiku-4-5-20251001
maxTurns: 1
cache-safe: true
output-schema: topSupportersOutputSchema
allowed-tools: []
references:
  - ./references/ranking-notes.md
---

# identify-top-supporters

Reads a period's engagement events (replies, reposts, quotes, likes,
bookmarks, mentions) and returns up to 30 ranked supporters. Used in
the `compound` phase to identify who to thank personally post-launch,
and in `steady` to surface champions worth re-activating.

## Input

See agent prompt.

## Output

See `topSupportersOutputSchema`.

## When to run

- Post-launch (`compound` phase), 3-5 days after launch date.
- Monthly in `steady` phase as part of the retro.
- Ad-hoc when the founder wants to send a thank-you batch.

The planner writes the ranked list to a `plan_items` row of kind
`analytics_summary` and the Today surface renders the top 10 by
default.
