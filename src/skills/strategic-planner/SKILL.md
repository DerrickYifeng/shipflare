---
name: strategic-planner
description: Produce the durable narrative path (thesis, arc, pillars, milestones, channel mix) for one product.
context: fork
agent: strategic-planner
model: claude-sonnet-4-6
maxTurns: 3
cache-safe: false
output-schema: strategicPathSchema
allowed-tools: []
shared-references:
  - launch-phases.md
references:
  - ./references/category-playbooks.md
  - ./references/milestone-to-thesis.md
---

# strategic-planner

One LLM call per run. Runs at two moments only:

1. **Onboarding commit** — the very first path for the user's product.
2. **Phase change** — e.g., `foundation → audience` as the launch date
   approaches, or `launched` flipping `compound → steady` at T+30.

NOT run on weekly cadence. That's the Tactical Planner's job.

## Input

See agent prompt. The `categoryPlaybook` reference is injected via
`references/category-playbooks.md` — the agent looks up the input's
`product.category` and applies the matching section.

## Output

See `strategicPathSchema`. Caller writes directly to the
`strategic_paths` table (columns match the schema's jsonb shapes).

## Why low frequency

The path is a frame that lasts weeks. Re-generating it on every Monday
would fight the Tactical Planner, which reads the active path as a
fixed reference. The API enforces this — only `POST /api/onboarding/commit`
and `POST /api/product/phase` (Phase 8) call this skill.

## Cache disabled

`cache-safe: false` because each user's input is unique enough that
cache hits are negligible and the cost savings (one call every 6+
weeks per user) don't justify the complexity.
