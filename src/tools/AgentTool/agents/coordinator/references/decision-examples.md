# Delegation decision examples

Four concrete examples showing the coordinator's reasoning pattern. Each shows
a goal, a `<thinking>` block with the decision rationale, and the resulting
action. Imitate this reasoning pattern on every goal.

## Example 1 — Direct handling (no Task)

user: "How many plan_items are scheduled for next week?"

assistant: <thinking>
This is a simple DB read — one query tool call gives the answer. No specialist
judgment needed. Use query_plan_items directly.
</thinking>

query_plan_items({ weekOffset: 1, status: ["planned", "drafted", "approved"] })

[tool_result: 12]

There are 12 plan_items scheduled for next week (3 drafted, 7 approved, 2 in
planning).

## Example 2 — Single specialist delegation

user: "I launched yesterday. Can we pivot the strategy to post-launch?"

assistant: <thinking>
Phase transition from `launching` to `launched` — the strategic narrative
needs to be re-written from pre-launch (waitlist focus) to post-launch
(compound/growth focus). That matches growth-strategist's description:
"USE when phase changes." One specialist, serial execution.
</thinking>

Task({
  subagent_type: "growth-strategist",
  description: "Post-launch strategic rewrite",
  prompt: `Product just launched (state transitioned from launching → launched
yesterday). Active path pathId=abc123 targets pre-launch waitlist growth.
Rewrite the path for a 30-day compound phase, focusing on retention loops,
case studies, and compound content. Preserve voice profile.`
})

[waits for tool_result → StructuredOutput with new pathId]

The growth-strategist has rewritten your strategy for post-launch compound
growth. Key shifts: thesis moved from "join the waitlist" to "see how X
founders use ShipFlare in week 1". New pillars: case-studies, retention-math,
community-voices. Want me to have content-planner schedule the first week?

## Example 3 — Parallel delegation

user: "Set up next week and pre-draft the X posts"

assistant: <thinking>
Two independent subtasks:
1. Plan next week — content-planner
2. Draft X posts — x-writer

These can start in parallel. But wait: x-writer needs plan_item context (theme,
angle, pillar), which doesn't exist until content-planner runs. So actually:
serial, not parallel.

UNLESS I tell x-writer to draft "backlog" posts using the current pillars
without waiting for specific plan_items. That's a valid pattern — it creates
a backlog content-planner can slot into this week's items after approval.

Decision: parallel with independent scopes.
</thinking>

Task({
  subagent_type: "content-planner",
  description: "Plan next week",
  prompt: `Generate plan_items for the week starting Monday {nextMondayISO}.
Use active path pathId={pathId}. Respect connected channels: {channels}.`
})
Task({
  subagent_type: "x-writer",
  description: "Pre-draft X backlog",
  prompt: `Draft 5 X posts on the pillars from path pathId={pathId}, using a
mix of angles (data, story, contrarian). Write them as stand-alone — not
tied to specific plan_items. The founder will review and content-planner
will slot them in after approval.`
})

## Example 4 — Serial chain (one Task depends on another)

user: "Write a draft based on whatever angle is working best this month"

assistant: <thinking>
I don't know which angle is working until I ask — analytics-analyst needs to
surface that from metrics. Then x-writer drafts using that angle. Strictly
serial: the writer's prompt depends on the analyst's output.
</thinking>

Task({
  subagent_type: "analytics-analyst",
  description: "Identify top angle",
  prompt: `From the last 4 weeks of post metrics, return the angle (from the
7: claim, story, contrarian, howto, data, case, synthesis) with the highest
engagement per impression. Return { angle, evidence }.`
})

[waits for tool_result]

<thinking>
Analytics returned "contrarian" with 2.3x baseline engagement. Now I can brief
the writer with that specific angle.
</thinking>

Task({
  subagent_type: "x-writer",
  description: "Draft contrarian post",
  prompt: `Draft one X post using the contrarian angle. Last 4 weeks of
winners: {evidence from analytics}. Aim for the same shape: an anti-conventional
wisdom claim backed by a concrete observation from {productName}.`
})
