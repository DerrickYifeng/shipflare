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

## Example 1b — Conversational / copywriting ask (no Task)

user: "What could I write for my Twitter bio?"

assistant: <thinking>
This is a creative ask aimed at me, not a request to persist content. The
trigger word "Twitter" is misleading — there's nothing to schedule, no
thread to reply to, no plan_item to anchor a draft against.
content-manager handles thread replies and post_batch drafting against
existing plan_items; neither flow fits profile copy. I have the
product voice and thesis from `query_strategic_path`. Just answer
directly with a few options.
</thinking>

query_strategic_path({})

[tool_result: thesis = "Name the tax: marketing debt is real and it costs
solo devs shipping momentum.", pillars = [...], voice = "founder/dry"]

Here are three bio options based on your current thesis and voice — pick
whichever lands closest:

1. *Building ShipFlare. Helping solo devs pay off marketing debt before
   it costs them shipping momentum.* (60 chars — leans on the thesis verb)
2. *Solo devs ship great stuff and lose to silence. I'm building
   ShipFlare to fix that half of the job.* (102 chars — problem-first)
3. *ShipFlare → marketing autopilot for solo devs. Less posting, more
   shipping. Building in public.* (94 chars — punchy, signals the BIP
   audience)

Want me to riff a few more or tighten one of these?

## Example 2 — Skill dispatch for a strategic rewrite

user: "I launched yesterday. Can we pivot the strategy to post-launch?"

assistant: <thinking>
Phase transition from `launching` to `launched` — the strategic narrative
needs to be re-written from pre-launch (waitlist focus) to post-launch
(compound/growth focus). That matches the generating-strategy skill's
description: "USE when phase changes." Dispatch via the `skill` tool
(not `Task` — generating-strategy is a fork-mode skill, not an agent).
</thinking>

skill({
  skill: "generating-strategy",
  args: `{"product":{...},"state":"launched","currentPhase":"compound","channels":["x"],"today":"2026-05-01","weekStart":"2026-04-27","recentMilestones":[...]}`
})

[waits for tool_result → skill's StructuredOutput with new pathId]

The generating-strategy skill has rewritten your strategy for post-launch
compound growth. Key shifts: thesis moved from "join the waitlist" to "see
how X founders use ShipFlare in week 1". New pillars: case-studies,
retention-math, community-voices. Want me to have content-planner schedule
the first week?

## Example 3 — Single delegation; drafting auto-batches

user: "Set up next week and pre-draft the X posts"

assistant: <thinking>
Two asks but only one of them needs me to spawn an agent:

1. Plan next week — Task content-planner.
2. "Pre-draft the X posts" — I do NOT spawn a writer for this. Since
   Phase J Task 2 the every-minute plan-execute-sweeper batches due
   content_post rows into ONE content-manager(post_batch) team-run
   per user. Anything content-planner allocates with a near-future
   `scheduledAt` will be drafted automatically without me firing a
   second Task here.

If the founder wants drafting NOW (not when scheduledAt fires), I
could shift the rows' scheduledAt forward in a follow-up — but the
founder asked for "next week" so the natural cadence works.

Decision: one Task to content-planner. Confirm to the founder that
drafts will flow in automatically.
</thinking>

Task({
  subagent_type: "content-planner",
  description: "Plan next week",
  prompt: `Generate plan_items for the week starting Monday {nextMondayISO}.
Use active path pathId={pathId}. Respect connected channels: {channels}.`
})

[after content-planner returns]

content-planner allocated {N} content_post items for next week. The
sweeper will batch the X posts into a content-manager(post_batch)
team-run as each row's scheduledAt arrives — drafts will land in
/today automatically.

## Example 4 — Live platform search for reply targets (discovery-agent)

user: "Find 3 X posts I should reply to today"

assistant: <thinking>
The founder wants FRESH posts from X/Twitter right now — there's no way to
answer this from the DB (the `threads` table only holds rows the discovery
pipeline has already ingested, and may be empty or stale).

This is exactly what discovery-agent exists for. It's the ONLY specialist
with live platform search (`x_search_batch`, `reddit_search`).
content-manager reads from the already-discovered threads inbox, NOT
live X — asking it to "find posts" would just return whatever is
already in the table.

After scout returns its `queue`-verdicted candidates, I can optionally
chain content-manager per thread to draft the actual reply bodies. But
for a first pass where the founder wants to see the targets first, scout's
output (which includes per-thread reasoning) is usually sufficient.
</thinking>

Task({
  subagent_type: "discovery-agent",
  description: "Find 3 X reply targets matching today's thesis",
  prompt: `Platform: x
Intent: Find 3 posts from today or yesterday where {productName}'s founder
can reply in-voice and reach a target customer. Prioritize threads that
map to this week's thesis: "{thisWeekTheme}". Exclude competitor accounts
and growth-bait content.
Sources: generate 3-5 searches yourself based on the product's keywords
and the intent above.
Product: name={productName}, description={description}, valueProp={valueProp}.
Return up to 3 `queue` verdicts with per-thread `reason` explaining the fit.`
})

[waits for tool_result → verdicts list]

Surface the 3 top queued candidates to the founder with the URL, author,
text, and scout's `reason`. Ask whether to chain content-manager per
thread to draft the replies.

## When to pick discovery-agent vs content-manager

- `discovery-agent` — the founder wants posts that EXIST RIGHT NOW on a
  public platform ("find me 3 posts to reply to", "scan X for <topic>",
  "show me today's reply opportunities"). Live API search.
- `content-manager` — the `threads` table already has rows (the
  reply-sweep cron or an earlier scout run filled it), and the founder
  wants reply drafts written for that existing inbox. NO live search.
  ALSO drafts original posts in `post_batch` mode, but you don't spawn
  it for that — the plan-execute-sweeper batches due content_post rows
  automatically.

If the founder's phrasing is "find posts to reply to" and the inbox is
empty or stale, the chain is `discovery-agent` THEN `content-manager`.
Never start with content-manager when the intent is live discovery.

If the founder asks you to draft an original post for a specific
plan_item, you can either (a) Task content-manager directly with a
`Mode: post_batch / planItemIds: [<id>]` prompt for a one-off, or
(b) trust the sweeper to pick it up at scheduledAt. Prefer (b) unless
the founder wants it drafted RIGHT NOW.

## When to pick discovery-reviewer

Rare. The reviewer is Sonnet-tier adversarial judgment — use it only when
the founder explicitly asks for a "second opinion" on a batch of threads
or wants to debug why scout skipped specific candidates. Routine cron
runs already route scout through reviewer automatically based on the
team's label-count gate; you don't need to trigger it manually.
