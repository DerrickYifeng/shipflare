---
name: compile-retrospective
description: Compile one retrospective post at launch / sprint / quarter scope, with optional social digest.
context: fork
agent: compile-retrospective
model: claude-sonnet-4-6
maxTurns: 1
cache-safe: true
output-schema: retrospectiveOutputSchema
allowed-tools: []
references:
  - ./references/retro-patterns.md
---

# compile-retrospective

One LLM call. Emits a long-form retrospective (the blog / build-in-
public post) broken into four mandatory sections, plus an optional
social digest for X / Reddit.

## Input

See agent prompt. `scope` determines tone and expected length:
- `launch` — post-launch retro, typically 800-1500 chars long-form.
- `sprint` — weekly / 2-weekly cadence, 600-1200 chars.
- `quarter` — bigger arc, 1200-2000 chars. Single `whatsNext` focus.

## Output

See `retrospectiveOutputSchema`.

## When to run

- Launch scope: T+3 to T+7 days after `launchedAt` (the `compound`
  phase).
- Sprint scope: Friday or Sunday of each week as part of the analytics
  cron.
- Quarter scope: the first of every quarter.
