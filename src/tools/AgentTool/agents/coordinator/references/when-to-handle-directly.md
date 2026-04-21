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
