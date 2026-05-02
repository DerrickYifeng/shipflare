<!-- Ported from src/tools/AgentTool/agents/content-planner/references/tactical-playbook.md
     during Phase G of the agent-skill-tool decomposition. The pure-allocation
     rules moved here; the agent retains orchestration (signal gathering via
     tools, optional post-add fan-out via Task). -->

# Allocation rules — five ordered steps

You read the active strategic path plus this week's signals (passed in
the skill input) and produce concrete `plan_items` for the next 7 days.

You do NOT write post bodies, email bodies, or reply drafts. You
schedule items — you attach the right skill + params so the downstream
plan-execute dispatcher can run them.

A bad plan under-schedules (3 items for a week → the founder drifts) or
over-schedules (40 items for a week → the approval queue becomes a
second job). A good plan is specific enough that Monday's Today page
renders without the founder wondering "what does this mean?".

## Inputs you have

The skill input carries:

- `targetWeekStart` — Monday 00:00 UTC of the week to plan (ISO).
- `now` — current UTC timestamp (ISO). Items must NEVER be scheduled
  with `scheduledAt <= now` — see "Never schedule in the past" below.
- `strategicPath` — the active path (thesis, phase, contentPillars,
  channelMix, thesisArc, milestones, phaseGoals).
- `signals.stalledItems` — last week's `planned`-but-undone items.
- `signals.lastWeekCompletions` — last week's finished items with their
  engagement metrics (where available).
- `signals.recentMilestones` — last 14 days of shipping signals.
- `signals.recentXPosts` — last 14 days of the founder's X timeline,
  when available; absent or empty when the user has no X channel or
  the timeline is empty.
- `connectedChannels` — channels the user has connected.

## Step 1 — Anchor the week

Find `thesisArc[i]` where `weekStart === targetWeekStart`. Extract
`theme` and `angleMix` for this week. If no match, fall back to the most
recent past week.

The `theme` is the single claim every `content_post` you schedule will
anchor to via `params.anchor_theme`. The `angleMix` constrains which
angles from the 7 (see "7-angles") your content items may use.

## Step 2 — Allocate content slots per `channelMix`

For each channel the user has connected (X / Reddit / Email):

- Channel distribution MUST match input `channelMix` **exactly**,
  item-for-item. `channelMix` is not a hint — it's a binding allocation.
  If `channelMix` says `{ x: { perWeek: 3 }, reddit: { perWeek: 1 }, email: { perWeek: 1 } }`
  and email is connected, you emit exactly 3 X posts + 1 reddit post +
  1 `email_send` item — not 2 reddit + 3 X + 0 email. Over-producing one
  channel to compensate for skipping another is a rejection condition.
- Schedule `channelMix[channel].perWeek` content items, spread across
  the week — not all on one day.
- Use `channelMix[channel].preferredHours` to pick `scheduledAt` UTC
  times. Spread across the list — don't stack two items in the same hour.
- Rotate through `contentPillars` — don't emit three posts on the same
  pillar back-to-back.
- Spread items across **all 7 days** of the week, not just 3-5. Aim for
  roughly 1 item per day on average (0-2 per day is fine). If you have
  9 items, spreading them across 7 days is better than clumping into 5 —
  this prevents approval overload on any single day and lets the founder
  ship steadily. When your schedule feels dense on some days, push an
  item to the emptier days instead.
- Distribute angles from `angleMix` (the week's recommended angles)
  across the items.

Emit one entry in the output `planItems` array per item. The caller
agent will call `add_plan_item` once per entry (concurrency-safe).

## Step 2.5 — Allocate daily reply slots per `channelMix[ch].repliesPerDay`

For each channel where `channelMix[channel].repliesPerDay > 0`:

- Emit ONE `content_reply` `plan_item` per day in the planned week.
  Seven days = seven `content_reply` rows per channel, max. (If
  planning starts mid-week, emit slots only for the remaining days —
  skip past dates per the "never schedule in the past" rule.)
- Each slot:
  - `kind: 'content_reply'`
  - `channel: <channel>` (X only at this stage; reddit's
    `repliesPerDay` is null/omitted by the strategist, so this loop
    naturally skips reddit.)
  - `userAction: 'approve'`
  - `skillName: null` (the daily reply-sweep cron + content-manager
    own this end-to-end)
  - `params: { targetCount: <channelMix[channel].repliesPerDay> }`
  - `scheduledAt`: pick the FIRST UTC hour from
    `channelMix[channel].preferredHours` and apply it to every day.
    All seven slots share the same hour-of-day — the daily cron fires
    once and walks each day's slot.
  - `title`: `"Reply session: ${repliesPerDay} replies"` (use the
    actual integer)
  - `description`: explain that the daily reply automation will run
    discovery + drafting and surface up to `targetCount` reply drafts
    on the Today page for approval.

If `channelMix.x.repliesPerDay` is null/0/omitted, skip this step
entirely — reply automation is opt-in per channel. The cap of one
slot per day per channel keeps the calendar uncluttered and matches
the cron's "once per UTC day per user" throttle.

## Step 3 — Schedule phase-appropriate setup_tasks / interviews

Draw from the "phase-task-templates" reference. Rules:

- Maximum 2 `setup_task` + 1 `interview` per week.
- Never duplicate a task from `signals.stalledItems` OR
  `signals.lastWeekCompletions`.
- Adapt the template's `params` based on product context — fill
  `{product.name}` placeholders.
- `setup_task` / `interview` items ALWAYS take `userAction: 'manual'`
  unless the template explicitly overrides.

### Foundation & audience phases: mandatory tasks

If the product state is `mvp` or the launch phase is `foundation` /
`audience`, you MUST include:

- At least 1 `interview` item (e.g. "Run 3 customer interviews").
- At least 1-2 `setup_task` items (e.g. "Validate messaging with 10
  potential users", "Set up basic analytics").

These de-risk the launch. The maximum-2-setup-task + 1-interview rule is
a ceiling, not a floor — in these phases aim FOR 1-2 setup_tasks and 1
interview, not fewer. Exception: only skip if
`signals.currentLaunchTasks` already covers the same topic (case-
insensitive title overlap), or if `signals.stalledItems` /
`signals.lastWeekCompletions` already contains a matching title.

### Foundation & audience phases: pillar mix clamp (HARD)

In any 7-day window at `foundation` or `audience` phase:

- At most **ONE** `hot_take` `content_post` plan_item.
- At most **ONE** `lesson` `content_post` plan_item that frames the
  takeaway as a generalized claim (vs. a first-person observation
  from the founder's own week).
- Remaining `content_post` items must come from `behind_the_scenes`,
  `question`, or `milestone`.

Reason: founders pre-launch / early-launch haven't earned the
meta-take pose. A `hot_take` from a 100-follower account reads as
posturing; a `behind_the_scenes` from the same account reads as
build-in-public. Symptoms downstream — `the real X is Y`,
`winners do X`, `most solo devs Y` — are banned in
`x-post-voice.md` hard rule §2.1.5, but it's cheaper to not
schedule the slot than to repair the draft after.

If the founder explicitly requests more, still emit only one
`hot_take` and one claim-style `lesson`, and note the override in
your `notes` output so the next planner run can revisit.

## Step 4 — Schedule emails per phase

Use the `email` cadence from `channelMix.email` if present. Per phase:

- `foundation` / `audience`: waitlist-focused emails — welcome
  confirmation, weekly update.
- `momentum`: pre-launch reminder to waitlist (1 email T-1).
- `launch`: launch-day email (T-0) + retrospective T+3.
- `compound` / `steady`: weekly digest OR thank-you batches.

For v1, emit the `email_send` row with `userAction='approve'` and leave
`skillName: null`. As of Phase E Day 3 the email drafting/sending skills
are not wired — the row currently advances through the state machine as
a manual-completion item so the founder can send the email off-platform.
A future phase rewires email to a team-run email agent; when that lands
the dispatch table row will pick up the new skill automatically.

### Before you move on — email check

If `channelMix.email` is present (user has email connected), STOP and
verify you've scheduled at least 1 `email_send` item for this week. If
not, add one now with `kind: 'email_send'` and
`userAction: 'approve'`. Do this in the same response — before moving to
Step 5. Dropping email is a common failure mode; this check is cheap
insurance.

## Step 5 — Pick the right skill + params per item, and write notes

For every scheduled item:

- Pick `skillName` to match the item's `kind`. As of Phase E Day 3 the
  runtime-loaded skills are narrow — only set `skillName` for the
  entries below; for any other kind, leave `skillName: null` and the
  dispatcher will route via (kind, channel) or manual-complete the row:
  - `content_post` → **leave `skillName: null`**. Content posts route
    through the post-writer team-run; the agent reads `plan_items.channel`
    (`x` or `reddit`) and consults the matching guide at draft time.
  - `content_reply` → **leave `skillName: null`**. Reply drafting is
    owned end-to-end by the daily reply-sweep cron — it reads each
    `content_reply` row's `params.targetCount`, runs discovery-agent +
    content-manager up to 3 inner attempts until the target is
    drafted, then transitions the row to `state='drafted'` (drafts
    surface on the Today page for the founder to approve).
  - `email_send` → `skillName: null`. Manual-completion until a future
    phase wires an email agent.
  - `interview` → `skillName: null` (founder runs the interview manually).
  - `setup_task` → `skillName: null` (manual labor — no setup_task skills
    are currently registered).
  - `launch_asset` → `skillName: null`. The individual launch-asset
    skills (draft-hunter-outreach, draft-waitlist-page, etc.) were
    retired; founders handle launch assets off-platform in the current
    release.
  - `analytics_summary`, `metrics_compute` → `skillName: null`
    (manual-completion; analytics pipeline is deferred).
- Fill `params` with the minimum the downstream consumer needs. For
  `content_post` that's `{ angle, topic, anchor_theme, pillar }` — the
  writer agent reads these when it runs. For email, `{ emailType,
  recipient }` so the founder can draft off-platform.
- Write a `title` and `description` the founder will see on the Today
  page. The description should explain *why* this item is scheduled now
  — what the founder learns by approving it.

Do not invent skillNames. If an item needs a skill you can't match,
emit `skillName: null` and `userAction: 'manual'`.

## Hard rules (every rule is a rejection condition if violated)

- NEVER schedule a `channel`-bound item for a platform not in
  `connectedChannels`. If `connectedChannels: ['x']`, do not emit ANY
  `reddit` or `email` item. Ignore `channelMix` entries for inactive
  channels.
- NEVER duplicate a task whose title appears in stalled items OR
  last-week completions (case-insensitive match).
- `kind` → `userAction` mapping is fixed:
  - `content_post` → `approve`
  - `content_reply` → `approve`
  - `email_send` → `approve`
  - `interview` → `manual`
  - `setup_task` → `manual` unless the template overrides
  - `launch_asset` → `manual` (designer work) or `approve` (draft skills)
  - `runsheet_beat` → inherits its own userAction from the runsheet
    output; typically NOT emitted by this planner directly
  - `metrics_compute` → `auto`
  - `analytics_summary` → `auto`
- Every `content_post` MUST set `params.anchor_theme` to the active
  week's `theme` (from step 1).
- `scheduledAt` for every item must fall in `[targetWeekStart, weekEnd]` —
  the week you're planning, nothing before or after.
- **Never schedule in the past.** If `now > targetWeekStart` (mid-week or
  weekend planning), the planning window collapses to
  `[max(now + 1 hour, targetWeekStart), weekEnd]`. Pick `scheduledAt`
  only from this remaining window. If there's not enough remaining
  window for the full `channelMix.perWeek` cadence (e.g. onboarding
  fires Saturday with perWeek=3 and only Sat/Sun left), schedule what
  fits and emit the rest with `notes` flagging the truncation. Better
  to ship 1 item Saturday than 3 items in the past.
- Minimum 3 items per week. Maximum 40.

## Stalled-item carryover

If `signals.stalledItems` returns items you want to surface again,
emit a `stalledCarriedOver` entry instead of a new `planItems` entry.
The caller will translate each `{ planItemId, newScheduledAt }` into an
`update_plan_item` call (which bumps `scheduledAt` on the existing row
rather than stamping a duplicate). Report the count in your `notes`.

## When inputs are thin

- `signals.recentMilestones: []` — still allocate the full `channelMix`
  cadence. Pillars rotate without a fresh ship story.
- `signals.stalledItems: [...]` — do NOT auto-reschedule everything;
  prefer writing a short `notes` line flagging them.
- `signals.lastWeekCompletions: []` — fine. Early week, nothing yet.
- No active path — STOP. Return `planItems: []` and put the gap into
  `notes` so the caller can SendMessage back to the coordinator.

## Pillar mix and metaphor ban

The planner balances the week's `content_post` items across a closed
**5-pillar vocabulary** AND derives a per-item `metaphor_ban` from the
founder's recent X timeline so consecutive posts don't recycle the
same idea wearing different hats.

### The 5 pillars

| Pillar | What it is | When to pick |
|---|---|---|
| `milestone` | Concrete shipped thing or revenue/user number with proof. | Real numbers exist this week (revenue update, user count, feature shipped, fundraise). |
| `lesson` | One specific takeaway from a recent failure / win, generalizable to other founders. | Founder hit something that generalizes. |
| `hot_take` | Contrarian opinion on the indie meta with a defensible position. | Founder has a strong view and the audience is mature enough. |
| `behind_the_scenes` | Process / workflow / decision the audience doesn't normally see. | Build state, kill decisions, hiring, tooling choices. |
| `question` | Genuine ask the founder needs answered, audience can reply usefully. | Real choice in front of the founder. |

**Hard rule — pillar cap:** at most **≤ 2 of any pillar per channel**
in a 7-day window. X and Reddit are independent audiences, so running
`milestone` twice on each is fine. The cap is `≤ 2 per pillar`, NOT
`≥ 1 of each` — empty pillars are fine when input is missing.

**Naming note:** plan_item `pillar` (this 5-cluster vocabulary, drives
post shape) is distinct from `strategic_paths.contentPillars` (3-4
free-form narrative themes set during onboarding, drives `theme`
selection). Both can coexist on a plan_item.

### Diversity inputs from `signals.recentXPosts`

Before scheduling content_post items, derive diversification metadata
from the X timeline snapshot the caller passes in.

If `signals.recentXPosts` is non-empty:

- Read every `body`. Identify 3–5 dominant metaphors / opening
  phrases / closing phrases used in the last 14 days.
- Note which metaphors correlated with high engagement
  (`metrics.likes + metrics.retweets * 3 > median across the
  returned set`). Lean into those when picking pillars/themes for
  the week. Flag the rest for the ban.

If `signals.recentXPosts` is absent or empty:

- Proceed without metaphor_ban. Note the gap in your `notes` output
  so the caller can surface the lack of timeline data.

For each plan_item to be added this week:

- Pick `pillar` from `{milestone | lesson | hot_take |
  behind_the_scenes | question}`. **Hard cap: max 2 of any pillar per
  channel** across the week's content_post items. Use the
  strategic-path's `contentPillars` library as a HINT for `theme`
  selection, NOT as a substitute for `pillar` selection.
- Pick `theme`: a concrete topic phrase (e.g. "first paying customer
  story", "killing feature X", "Stripe webhook gotcha"). Each item
  this week gets a distinct theme.
- Compute `metaphor_ban`: union of (metaphors extracted above) +
  (themes/key phrases of sibling plan_items already added in this
  turn). Cap at 20 phrases per item.
- Set `arc_position` to `{index, of}` reflecting placement in the
  week.
- Optional `cross_refs`: include only when the arc calls for an
  explicit callback (e.g. "Mon: shipped X. Wed: lesson from X." →
  Wed item cross_refs Mon's id).

Emit each as a `planItems` entry — the caller's `add_plan_item`
validates the new `params` fields against `contentPostParamsSchema`
(out-of-vocab pillars and oversized arrays are hard rejects there).

### What to ban specifically

Examples of phrases that get into `metaphor_ban` after the user has
posted them recently:

- Concrete metaphors: `"debt"`, `"compound"`, `"owe"`, `"interest"`
  (when used metaphorically not literally)
- Stock openers: `"shipped X on a"`, `"told nobody for"`,
  `"daily posting isn't a"`
- Stock closers: `"ship first, tell second"`, `"that's the gap"`

The planner LLM extracts these from the bodies — no n-gram counter,
no embedding model. Trust the read.

### When the timeline is empty

- New user, zero recent tweets → `metaphor_ban: []` for every item.
  Pillar mix still applies.
- User connected X but hasn't posted → same. Pillar mix only.

The smarter planner gets MORE valuable as the founder's history
grows, but it works on day 1 with empty input.
