---
name: allocating-plan-items
description: Given an active strategic_path and this week's signals (stalled items, last-week completions, recent milestones, recent X posts, connected channels), allocate plan_items for the coming 7 days with scheduledAt timestamps. Pure transformation — does not query the DB, does not write plan_items. The caller (content-planner agent) handles signal gathering and persistence.
context: fork
model: claude-sonnet-4-6
maxTurns: 1
allowed-tools:
references:
  - allocation-rules
  - 7-angles
  - phase-task-templates
---

# Allocate plan_items for one week

You receive a strategic_path snapshot + this week's signals, and you
emit the concrete plan_items the founder will work through across the
next 7 days. You do NOT query the database, spawn writers, persist
rows, or send messages — those are the caller agent's responsibilities.
Your only job is allocation.

## Your input

The caller passes a JSON object as `$ARGUMENTS`. Parse it before
proceeding. Expected fields:

- `strategicPath` — `{ thesis, phase, contentPillars, channelMix, thesisArc?, milestones?, phaseGoals? }`.
- `signals.stalledItems` — last week's `planned`-but-undone items.
- `signals.lastWeekCompletions` — last week's finished items + metrics.
- `signals.recentMilestones` — last 14 days of shipping signals.
- `signals.recentXPosts` — optional 14-day X timeline snapshot.
- `connectedChannels` — connected channels (`['x']`, `['x', 'email']`, …).
- `targetWeekStart` — Monday 00:00 UTC of the week to plan (ISO).
- `now` — current UTC timestamp (ISO), drives "never schedule in the past".
- `trigger` — optional `kickoff` / `weekly` / `phase_transition` hint.

$ARGUMENTS

If a critical field is missing (no `strategicPath`, no
`targetWeekStart`), return `planItems: []` and explain the gap in
`notes` — do NOT fabricate schedule data.

## Your workflow

Apply every rule in the **allocation-rules** reference below. The
five ordered steps are:

1. Anchor the week — pull `theme` + `angleMix` from `thesisArc`.
2. Allocate content slots per `channelMix` (and 2.5: daily reply
   slots per `repliesPerDay`).
3. Schedule phase-appropriate `setup_task` / `interview` items.
4. Schedule emails per phase (and the email check before Step 5).
5. Pick the right `skillName` + `params` per item; write `notes`.

The reference also covers:

- Hard rules (rejection conditions — never violate).
- Stalled-item carryover (emit into `stalledCarriedOver`, not
  `planItems`).
- Pillar mix and metaphor ban (5 pillars, 14-day timeline read).
- Behavior when inputs are thin or the X timeline is empty.

## Output

Return a single JSON object — no markdown fences, no prose. Start
`{`, end `}`. Shape:

```json
{
  "planItems": [
    {
      "kind": "content_post",
      "channel": "x",
      "phase": "foundation",
      "userAction": "approve",
      "title": "...",
      "description": "...",
      "scheduledAt": "2026-05-04T13:00:00Z",
      "skillName": null,
      "params": { "anchor_theme": "...", "pillar": "milestone", "theme": "...", "metaphor_ban": [] }
    }
  ],
  "stalledCarriedOver": [
    { "planItemId": "pi_abc", "newScheduledAt": "2026-05-05T13:00:00Z" }
  ],
  "notes": "Carried over 1 stalled X post; no emails this week (email not connected)."
}
```

The caller will spread each `planItems` entry into `add_plan_item` and
each `stalledCarriedOver` entry into `update_plan_item`. Out-of-vocab
fields are hard rejects at the tool layer — stick to the schema.
