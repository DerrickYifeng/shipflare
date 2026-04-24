# When to handle directly

Spawning a specialist via `Task` is expensive: it costs extra LLM turns,
burns context, and produces a round-trip delay the founder can feel. Before
you reach for Task, check whether one of your direct tools already answers
the goal. If it does, handle it yourself.

This file enumerates the concrete founder-question patterns that should
route to direct tools, not Task.

## query_team_status — "status of the team"

Use directly for:

- "Who's working on what?"
- "Did Maya finish the Friday post?"
- "Is anyone waiting on me?"
- "What's the team up to right now?"

One call returns `Array<{ memberId, agent_type, display_name, status,
currentTask? }>`. Don't spawn a specialist for this — you already have
the answer.

## query_plan_items — "this week's schedule"

Use directly for:

- "How many items are scheduled this week / next week?"
- "Show me the approved posts for Friday."
- "What's still in `planned` state?"
- "Show me plan_item abc123."

The tool takes `{ weekOffset?, status?, id?, limit? }`. One call is
almost always enough. Don't delegate simple read-outs.

## query_strategic_path — "what's our strategy?"

Use directly for:

- "What's our current thesis?"
- "What pillars did we pick?"
- "What's the phase goal for momentum?"

Returns the active `StrategicPath` for the product (or `null` if
growth-strategist hasn't written one yet). Only spawn growth-strategist
when the thesis needs to be *rewritten* — reading it is a direct call.

## add_plan_item — "schedule one specific item"

Use directly when the founder asks to add ONE item with clear
parameters. Examples that match:

- "Schedule a tweet for tomorrow at 3pm UTC about the launch."
- "Add a setup task: write the v1.1 brief."

When the founder's ask is "plan this whole week for me" or "fill the
rest of the week with posts on the new pillar", delegate to
content-planner — that's the planner's job, not yours.

## update_plan_item — fix, cancel, or re-time one item

Use directly when the founder wants to modify ONE existing item
without rewriting the whole plan:

- "Cancel Thursday's reply post" → patch `{ state: 'superseded' }`
- "Move the launch tweet to Friday 3pm" → patch `{ scheduledAt: '...' }`
- "This draft needs approval before it ships" → patch
  `{ userAction: 'approve' }`
- "Rename the setup task to 'Write v1.2 brief'" → patch `{ title }`

### Replanning without delegation (the "clean up the mess" case)

When the founder says "the week is a mess — clean it up" or "replan
this week" AND the fix is obviously mechanical (duplicate drafts,
overdue items that should be dropped, mis-scheduled posts), handle it
yourself with a sequence of `update_plan_item` calls — do NOT stamp
new rows and leave the old ones confusing the founder.

Pattern:

1. `query_plan_items({ weekOffset: 0 })` to see the current mess.
2. Decide which rows are duplicates / overdue / wrong-timed.
3. For each row you're cancelling: `update_plan_item(id, { state:
   'superseded' })`. For each row you're re-timing: `update_plan_item(id,
   { scheduledAt })`.
4. If new items are genuinely needed, `add_plan_item` them after.
5. Summarise what you changed in the final StructuredOutput.summary —
   founders care about what you dropped and what you re-scheduled.

Delegate to content-planner ONLY when the cleanup requires fresh
strategic thinking (picking new pillars, re-allocating across channels
for the whole week). Pure mechanical flips belong with you.

### What update_plan_item will NOT do

- Modify rows already in `executing` / `completed` / `failed`. Those
  are frozen for audit. If a completed post needs a follow-up, add a
  new `plan_item` scheduled for the future — don't rewrite the past.
- Delete rows. Supersede them instead; the row stays in the DB for
  history but stops showing as actionable.

## SendMessage — "steer a running specialist"

Use directly to nudge an already-running team member mid-task. The
message lands on their personal channel and they see it on their next
turn. Typical patterns:

- "Tell the writer to make the post shorter."
- "Ask the planner to skip Thursday — I'll be traveling."

Don't use SendMessage to hand off a new task — that's what Task is for.
Use SendMessage only when someone is already working and their scope
needs adjusting.

## When a direct tool is close but not enough

If one direct tool returns the raw data but the founder asked for
judgment ("is this a good thesis?", "should we replan?"), read the
data with the direct tool and then spawn the specialist with the
concrete data pre-loaded in the prompt. Don't make the specialist
re-read something you already have.

## Fast check before every turn

Ask yourself: "Could I answer this with one or two tool calls and no
specialist?" If yes — do that. If no — pick the specialist whose
description matches, and spawn.
