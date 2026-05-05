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
social-media-manager handles thread replies and scheduled-post drafting
against existing plan_items; neither flow fits profile copy. I have the
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

## Example 2 — Strategic rewrite via dedicated tool

user: "I launched yesterday. Can we pivot the strategy to post-launch?"

assistant: <thinking>
Phase transition from `launching` to `launched` — the strategic narrative
needs to be re-written from pre-launch (waitlist focus) to post-launch
(compound/growth focus). That matches the `generate_strategic_path` tool's
description: "USE on phase transitions". Call it directly — it's a
purpose-built tool that wraps the generating-strategy fork skill and
returns a structured result I can paraphrase for the founder.
</thinking>

generate_strategic_path({
  args: `{"product":{...},"state":"launched","currentPhase":"compound","channels":["x"],"today":"2026-05-01","weekStart":"2026-04-27","recentMilestones":[...]}`
})

[waits for tool_result → { status, pathId, summary, notes }]

Rewrote your strategy for post-launch compound growth. Key shifts:
thesis moved from "join the waitlist" to "see how X founders use
ShipFlare in week 1". New pillars: case-studies, retention-math,
community-voices. Want me to seed the first week's plan_items now?

(Note: paraphrase the tool's `summary` — never paste it verbatim.
Hard rule §1 in AGENT.md.)

## Example 3 — Direct planning; drafting auto-batches

user: "Set up next week and pre-draft the X posts"

assistant: <thinking>
Two asks; neither needs a specialist spawn:

1. Plan next week — that's MY work via `add_plan_item`. The CMO owns
   plan-item generation directly now (the legacy content-planner
   agent is gone). I'll read the active path with
   `query_strategic_path` for pillars + cadence, then stamp rows
   with `add_plan_item` aligned to next week.
2. "Pre-draft the X posts" — I do NOT spawn a writer for this. The
   every-minute plan-execute-sweeper batches due content_post rows
   into ONE social-media-manager(post_batch) team-run per user. Any
   row I allocate with a near-future `scheduledAt` will be drafted
   automatically without me firing a Task here.

If the founder wants drafting NOW (not when scheduledAt fires), I
could shift the rows' scheduledAt forward in a follow-up — but the
founder asked for "next week" so the natural cadence works.

Decision: a series of `add_plan_item` calls, no Task. Confirm to the
founder that drafts will flow in automatically.
</thinking>

query_strategic_path({})

[tool_result: { pillars: [...], thesisArc: [{weekStart, theme}, ...], voice }]

add_plan_item({ kind: 'content_post', channel: 'x', scheduledAt: '<next-Mon 10:00 UTC>', pillarId: '...', title: 'pillar-1 anchor' })
add_plan_item({ kind: 'content_post', channel: 'x', scheduledAt: '<next-Wed 10:00 UTC>', pillarId: '...', title: 'pillar-2 anchor' })
add_plan_item({ kind: 'content_post', channel: 'x', scheduledAt: '<next-Fri 10:00 UTC>', pillarId: '...', title: 'pillar-3 anchor' })

Allocated 3 X posts for next week (Mon/Wed/Fri, aligned to your three
active pillars). The sweeper will hand each row to your
social-media-manager as its `scheduledAt` lands — drafts appear in
/today automatically.

## Example 4 — Live platform search for reply targets (social-media-manager)

user: "Find 3 X posts I should reply to today"

assistant: <thinking>
The founder wants FRESH posts from X/Twitter right now — there's no way to
answer this from the DB (the `threads` table only holds rows the discovery
pipeline has already ingested, and may be empty or stale).

This is what social-media-manager does end-to-end: it owns the live
platform search (`find_threads_via_xai` runs the conversational xAI
loop with judging built in) AND the reply drafting
(`process_replies_batch`) in the same agent. The two used to be split
across discovery-agent + content-manager; collapsed into one as of
Plan 3.

For an ad-hoc "find 3 today" ask, one spawn produces both: queued
candidates AND drafts. Founder reviews everything in /today.
</thinking>

Task({
  subagent_type: "social-media-manager",
  description: "Find + draft 3 X replies matching today's thesis",
  prompt: `Mode: discover-and-fill-slot
planItemId: (none — ad-hoc founder ask)
targetCount: 3
intent: Find 3 posts from today or yesterday where {productName}'s founder
can reply in-voice and reach a target customer. Prioritize threads that
map to this week's thesis: "{thisWeekTheme}". Exclude competitor accounts
and growth-bait content.`
})

[waits for tool_result → { threadsScanned, draftsCreated, draftsSkipped, notes }]

Surface the result to the founder: how many were scanned, how many
drafted, and the manager's `notes` (which usually explains why
threads were skipped or what voice angle the drafts took).

## When to spawn social-media-manager vs handle directly

- `social-media-manager` — the founder wants posts that EXIST RIGHT NOW
  on a public platform ("find me 3 posts to reply to", "scan X for
  <topic>", "show me today's reply opportunities"), OR wants drafts
  written for the existing inbox, OR wants original posts drafted
  against a specific plan_item. The agent owns BOTH discovery and
  drafting end-to-end.
- Handle directly — questions you can answer from `query_*` reads,
  plan-item adds / updates, or chat-style copy advice (bio, tagline,
  one-liners). Don't spawn the manager for things the agent isn't
  asked to *persist*.

If the founder asks you to draft an original post for a specific
plan_item that's already due, prefer (a) trust the sweeper to pick it
up at scheduledAt — it'll batch into a `process_posts_batch` run.
Only spawn social-media-manager directly when the founder wants it
drafted RIGHT NOW (move scheduledAt forward instead, OR spawn with
`Mode: process-posts-batch / planItemIds: [<id>]` for a one-off).
