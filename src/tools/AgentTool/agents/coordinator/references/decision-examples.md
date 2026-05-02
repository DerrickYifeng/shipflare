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
thread to reply to, no plan_item to anchor a draft against. post-writer
drafts plan-item-anchored posts; community-manager handles thread replies;
neither is right for profile copy. I have the product voice and thesis
from `query_strategic_path`. Just answer directly with a few options.
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

## Example 3 — Parallel delegation

user: "Set up next week and pre-draft the X posts"

assistant: <thinking>
Two independent subtasks:
1. Plan next week — content-planner
2. Draft X posts — post-writer (with channel='x' in the prompt)

These can start in parallel. But wait: post-writer needs plan_item context
(theme, angle, pillar), which doesn't exist until content-planner runs. So
actually: serial, not parallel.

UNLESS I tell post-writer to draft "backlog" posts using the current pillars
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
  subagent_type: "post-writer",
  description: "Pre-draft X backlog",
  prompt: `channel: x
Draft 5 X posts on the pillars from path pathId={pathId}, using a
mix of angles (data, story, contrarian). Write them as stand-alone — not
tied to specific plan_items. The founder will review and content-planner
will slot them in after approval.`
})

## Example 4 — Live platform search for reply targets (discovery-agent)

user: "Find 3 X posts I should reply to today"

assistant: <thinking>
The founder wants FRESH posts from X/Twitter right now — there's no way to
answer this from the DB (the `threads` table only holds rows the discovery
pipeline has already ingested, and may be empty or stale).

This is exactly what discovery-agent exists for. It's the ONLY specialist
with live platform search (`x_search_batch`, `reddit_search`). post-writer
can't do this — it has no search tools, and asking it to "find posts"
will produce fabricated placeholders that look like reply drafts but are
actually hallucinated. community-manager reads from the already-discovered
threads inbox, NOT live X.

After scout returns its `queue`-verdicted candidates, I can optionally
chain community-manager per thread to draft the actual reply bodies. But
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
text, and scout's `reason`. Ask whether to chain community-manager per
thread to draft the replies.

## When to pick discovery-agent vs community-manager vs post-writer

- `discovery-agent` — the founder wants posts that EXIST RIGHT NOW on a
  public platform ("find me 3 posts to reply to", "scan X for <topic>",
  "show me today's reply opportunities"). Live API search.
- `community-manager` — the `threads` table already has rows (the
  reply-sweep cron or an earlier scout run filled it), and the founder
  wants reply drafts written for that existing inbox. NO live search.
- `post-writer` — the founder wants a NEW original post drafted (X or
  Reddit), for a specific plan_item. NOT for replies. NOT for finding
  posts. Pass the channel through in the prompt or via the plan_item.

If the founder's phrasing is "find posts to reply to" and the inbox is
empty or stale, the chain is `discovery-agent` THEN `community-manager`.
Never start with community-manager when the intent is live discovery.

## When to pick discovery-reviewer

Rare. The reviewer is Sonnet-tier adversarial judgment — use it only when
the founder explicitly asks for a "second opinion" on a batch of threads
or wants to debug why scout skipped specific candidates. Routine cron
runs already route scout through reviewer automatically based on the
team's label-count gate; you don't need to trigger it manually.
