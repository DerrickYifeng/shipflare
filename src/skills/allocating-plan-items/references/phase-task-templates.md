<!-- Ported from src/skills/tactical-planner/references/phase-task-templates.md (v2).
     Shared by the generating-strategy skill (when shaping phase-aware milestones) and
     content-planner (when allocating non-content plan_items). -->

# Phase task templates

A library of `plan_items` the content-planner can schedule, organized
by phase. Each template carries a
`{ kind, title, description, channel, userAction, skillName, params }`
shape — the planner should fill in product-specific strings, not emit
the template verbatim.

## skillName reality check (Phase E Day 3)

The `skillName: '...'` hints in the templates below reflect the v2
atomic-skill set. Most of those skills were retired — this file now
annotates each dead hint with `# Phase E Day 3: skill retired`. For the
content-planner:

- `content_post` rows MUST set `skillName: null` and route via `channel`
  (`x` and `reddit` both go to `post-writer`; the writer reads `channel`
  to pick the right platform guide).
- `content_reply` rows MUST set `skillName: null`. Reply drafting is
  owned end-to-end by the daily reply-sweep cron, which reads each
  row's `params.targetCount`, runs discovery-agent + content-manager
  in a retry loop until the target is filled (max 3 inner attempts),
  and transitions the row to `state='drafted'` so the drafts surface
  on the Today page.
- **Every template's `skillName` is currently retired** — leave `null`
  and the plan-execute dispatcher will route via the shell-route table
  (manual / auto completion) until a future phase rewires the kind to
  a team-run agent.

The kind + userAction + channel + params fields still matter exactly as
written; only the skillName column changed.

Rules:
- At most 2 `setup_task` + 1 `interview` per week (hard cap).
- Never duplicate a title already in stalled / last-week completed items.
- Pick 2-4 of these per week alongside the content slots.
- `{product.name}` and similar placeholders get filled at emit time.

---

## foundation (6+ weeks before launch)

Goal: de-risk positioning + plant audience seeds.

### 1. setup_task — Run 5 customer interviews
- `title`: "Run 5 discovery interviews"
- `description`: "Follow-up 3 days after product signup (or cold
  outreach to the target ICP). 30-minute calls, record pain points."
- `channel`: null
- `userAction`: 'manual'
- `skillName`: null
- `params`: `{ targetCount: 5, intent: 'discovery' }`

### 2. interview — Prep interview questions (discovery)
- `title`: "Generate discovery interview questions"
- `description`: "Exactly 10 questions tailored to {product.name} +
  current phase. Founder uses them across the 5 scheduled interviews."
- `channel`: null
- `userAction`: 'approve'
- `skillName`: null  # Phase E Day 3: skill retired; manual-completion
- `params`: `{ intent: 'discovery' }`

### 3. setup_task — Draft waitlist page
- `title`: "Draft {product.name} waitlist page"
- `description`: "Generate HTML + structured copy for the waitlist
  landing. Founder hosts on their domain."
- `channel`: null
- `userAction`: 'approve'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{ includeEmailCapture: true }`

### 4. setup_task — Nail positioning one-liner
- `title`: "Ship a tested one-liner for {product.name}"
- `description`: "One sentence that names the outcome + the ICP. Test
  it on 3 people outside the product — does it survive?"
- `channel`: null
- `userAction`: 'manual'
- `skillName`: null
- `params`: `{}`

### 5. content_post — Build-in-public opener
- `title`: "First build-in-public post: why {product.name} exists"
- `description`: "Story-angle origin. Specific problem you hit last
  month. End on a question inviting replies."
- `channel`: 'x'
- `userAction`: 'approve'
- `skillName`: null  # content_post routes to post-writer via channel
- `params`: `{ angle: 'story', pillar: '{contentPillars[0]}' }`

### 6. email_send — Waitlist welcome drip
- `title`: "Welcome email draft for waitlist signups"
- `description`: "Triggered on first signup. 100-120 words, invite a
  reply, no CTA."
- `channel`: 'email'
- `userAction`: 'approve'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{ emailType: 'welcome' }`

### 7. analytics_summary — Week 1 baseline
- `title`: "Baseline metrics for week 1"
- `description`: "Baseline posts published + followers + engagement
  rate. Feeds future retros."
- `channel`: null
- `userAction`: 'auto'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{}`

### 8. content_post — Contrarian week-opener
- `title`: "Contrarian post: the category assumption {product.name} rejects"
- `description`: "One claim against the default solution in the
  category. Defend with a specific reason."
- `channel`: 'x'
- `userAction`: 'approve'
- `skillName`: null  # content_post routes to post-writer via channel
- `params`: `{ angle: 'contrarian', pillar: '{contentPillars[1]}' }`

### 9. setup_task — Seed waitlist with 10 founders
- `title`: "Seed waitlist with 10 founders from your network"
- `description`: "Warm outreach to 10 founders in the ICP. No
  pitch — just 'I'm building X, curious if this maps to your pain.'"
- `channel`: null
- `userAction`: 'manual'
- `skillName`: null
- `params`: `{ targetCount: 10 }`

---

## audience (8-28 days before launch)

Goal: build launch-ready audience. Weekly rhythm matters most here.

### 1. content_post — Data-angle post on shipped signal
- `title`: "Data post: what shipping {recentMilestone.title} revealed"
- `description`: "One number + its implication. Lead with the metric,
  unpack why it matters."
- `channel`: 'x'
- `userAction`: 'approve'
- `skillName`: null  # content_post routes to post-writer via channel
- `params`: `{ angle: 'data', pillar: '{contentPillars[0]}' }`

### 2. content_post — Howto playbook post
- `title`: "Howto post: the 5-step workflow {product.name} enables"
- `description`: "Imperative walkthrough of one end-to-end workflow.
  Each step independently verifiable."
- `channel`: 'x'
- `userAction`: 'approve'
- `skillName`: null  # content_post routes to post-writer via channel
- `params`: `{ angle: 'howto', pillar: '{contentPillars[1]}' }`

### 3. content_reply — Daily reply slot (one per day per channel)
- `title`: "Reply session: ${targetCount} replies"  # use the
  channelMix[channel].repliesPerDay value verbatim
- `description`: "Daily reply automation runs at this hour:
  discovery-agent finds candidate threads, content-manager drafts up
  to ${targetCount} replies for your review. The session retries up to
  3 times within the day if the first scan comes up short."
- `channel`: 'x'  # X only at this stage; reddit repliesPerDay stays null
- `userAction`: 'approve'
- `skillName`: null  # daily reply-sweep cron owns this end-to-end
- `params`: `{ targetCount: <channelMix.x.repliesPerDay> }`
- `scheduledAt`: same UTC hour every day (use the first
  `channelMix.x.preferredHours` entry — the daily cron fires once per
  UTC day per user, so all seven slots share the same hour-of-day)

### 4. setup_task — Identify and queue 20 hunters
- `title`: "Build hunter target list for Product Hunt"
- `description`: "20 hunters who've launched in this category in the
  last 90 days. Store their handles + recent hunts for personalization."
- `channel`: null
- `userAction`: 'manual'
- `skillName`: null
- `params`: `{ targetCount: 20 }`

### 5. launch_asset — Community rules scan (reddit)
- `title`: "Read rules for target subreddits"
- `description`: "Skim rules for the 2-4 target subreddits manually;
  know each sub's self-promotion policy before posting. (Automated
  scan deferred to a future phase.)"
- `channel`: 'reddit'
- `userAction`: 'approve'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{}`

### 6. email_send — Weekly build-in-public email
- `title`: "Weekly update email to waitlist"
- `description`: "One shipped milestone + one pre-launch date update.
  120-180 words."
- `channel`: 'email'
- `userAction`: 'approve'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{ emailType: 'drip_week_1' }`

### 7. interview — Activation interviews (current signups)
- `title`: "Run 3 activation interviews with beta users"
- `description`: "30-min calls with users who signed up but didn't
  activate. Prepare an activation-intent question script; the founder
  runs the calls and follows up."
- `channel`: null
- `userAction`: 'manual'
- `skillName`: null
- `params`: `{ targetCount: 3, intent: 'activation' }`

### 8. content_post — Case post referencing an interviewed user
- `title`: "Case post: what {customer} discovered with {product.name}"
- `description`: "One user's specific outcome, with consent. Reader-
  facing generalization in the last sentence."
- `channel`: 'x'
- `userAction`: 'approve'
- `skillName`: null  # content_post routes to post-writer via channel
- `params`: `{ angle: 'case', pillar: '{contentPillars[2]}' }`

### 9. launch_asset — Community hot-posts scan
- `title`: "Read hot posts in target subreddits"
- `description`: "Browse hot posts in the target subs to derive top
  formats + a weekly insight before posting. (Automated scan deferred
  to a future phase.)"
- `channel`: 'reddit'
- `userAction`: 'approve'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{ limit: 25 }`

### 10. analytics_summary — Weekly rhythm check
- `title`: "Analytics summary for week {weekIndex}"
- `description`: "Compare to prior week; flag whether cadence is on
  plan."
- `channel`: null
- `userAction`: 'auto'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{}`

---

## momentum (T-7 to T-1)

Goal: maximize launch-day reach. Fewer net-new projects; tighten every asset.

### 1. launch_asset — Draft launch-day comment
- `title`: "Pinned maker comment for Product Hunt launch"
- `description`: "draft-launch-day-comment with one of four hook
  kinds. Pin within 5min of T-0."
- `channel`: 'producthunt'
- `userAction`: 'approve'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{}`

### 2. launch_asset — Hunter outreach batch (10 DMs)
- `title`: "Personalized hunter DMs (batch of 10)"
- `description`: "draft-hunter-outreach per hunter from your target
  list. Deduplicate on (hunter, personalizationHook)."
- `channel`: 'producthunt'
- `userAction`: 'approve'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{ batchSize: 10 }`

### 3. launch_asset — Gallery image + video briefs
- `title`: "Briefs for PH gallery image + 30s video"
- `description`: "generate-launch-asset-brief for gallery_image and
  video_30s. Designer has 3-7 days to execute."
- `channel`: null
- `userAction`: 'approve'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{ assetTypes: ['gallery_image', 'video_30s'] }`

### 4. launch_asset — Build launch-day runsheet
- `title`: "Hourly runsheet for launch day"
- `description`: "build-launch-runsheet with T-1 through T+12 beats
  across channels."
- `channel`: null
- `userAction`: 'approve'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{}`

### 5. content_post — Daily thesis post
- `title`: "Daily launch-week thesis anchor"
- `description`: "One post per day, each a different angle on the
  week's theme. 5 posts across the week."
- `channel`: 'x'
- `userAction`: 'approve'
- `skillName`: null  # content_post routes to post-writer via channel
- `params`: `{ angle: 'claim' }`

### 6. email_send — Pre-launch reminder to waitlist
- `title`: "T-1 reminder email to waitlist"
- `description`: "120-140 words. Explicit launch URL + time zone."
- `channel`: 'email'
- `userAction`: 'approve'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{ emailType: 'drip_week_2' }`

### 7. setup_task — Verify launch assets ready
- `title`: "Pre-launch asset readiness check"
- `description`: "Confirm gallery image / video / waitlist email /
  first comment are all ready T-1."
- `channel`: null
- `userAction`: 'manual'
- `skillName`: null
- `params`: `{}`

### 8. setup_task — Top-supporter identification
- `title`: "Identify top 10 supporters for launch thanks"
- `description`: "identify-top-supporters across X engagement last
  14 days. Prep the T+2 thank-you list."
- `channel`: null
- `userAction`: 'approve'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{ topN: 10 }`

### 9. metrics_compute — Launch baseline snapshot
- `title`: "Pre-launch metrics snapshot"
- `description`: "Baseline for post-launch comparison. Follower count,
  impressions, engagement rate."
- `channel`: null
- `userAction`: 'auto'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{}`

### 10. content_post — Contrarian pre-launch post
- `title`: "Contrarian post: {category} assumption we're rejecting"
- `description`: "One stated-against claim aimed at the launch week's
  thesis."
- `channel`: 'x'
- `userAction`: 'approve'
- `skillName`: null  # content_post routes to post-writer via channel
- `params`: `{ angle: 'contrarian' }`

---

## launch (T-0 day)

Goal: execute the runsheet. Typically no new plan items here — the
runsheet rows ARE the plan. Only schedule beats pulled from
`build-launch-runsheet`. The content-planner should emit at most 1-2
runsheet_beats manually; the rest come from the runsheet skill.

---

## compound (T+0 to T+30)

Goal: convert launch-day audience into retention + second wave.

### 1. content_post — Day 3 retro post
- `title`: "Day-3 launch retrospective"
- `description`: "Numbers + one surprise + one miss + next-7-day
  focus. 200-240 words."
- `channel`: 'x'
- `userAction`: 'approve'
- `skillName`: null  # content_post routes to post-writer via channel
- `params`: `{ angle: 'data', pillar: 'retro' }`

### 2. email_send — Thank-you email to top supporters
- `title`: "Personal thank-you emails to top 10 supporters"
- `description`: "Individually drafted (not batch-blast). Reference
  their specific action."
- `channel`: 'email'
- `userAction`: 'approve'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{ emailType: 'thank_you', targetCount: 10 }`

### 3. interview — Retention interviews
- `title`: "Run 3 retention interviews"
- `description`: "Users with >=3 active days post-launch. Use
  intent='retention' script."
- `channel`: null
- `userAction`: 'manual'
- `skillName`: null
- `params`: `{ targetCount: 3, intent: 'retention' }`

### 4. analytics_summary — Post-launch top supporters
- `title`: "Identify top supporters from launch week"
- `description`: "identify-top-supporters across the 7-day launch
  window. Feeds the thank-you list."
- `channel`: null
- `userAction`: 'auto'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{ windowDays: 7, topN: 30 }`

### 5. content_post — Case post referencing a new user
- `title`: "Case post: an early user's specific outcome"
- `description`: "With consent. Anchored to the week's theme."
- `channel`: 'x'
- `userAction`: 'approve'
- `skillName`: null  # content_post routes to post-writer via channel
- `params`: `{ angle: 'case' }`

---

## steady (T+30+)

Goal: durable rhythm. No panic moves.

### 1. content_post — Weekly thesis post
- `title`: "This week's thesis post"
- `description`: "Anchored to thesisArc[thisWeek].theme. Angle per
  angleMix."
- `channel`: 'x'
- `userAction`: 'approve'
- `skillName`: null  # content_post routes to post-writer via channel
- `params`: `{}`

### 2. content_reply — Reply session
- `title`: "Reply session for the week"
- `description`: "5 high-signal replies within the 15-min window."
- `channel`: 'x'
- `userAction`: 'approve'
- `skillName`: null  # content-manager owns reply drafting end-to-end
- `params`: `{ targetCount: 5 }`

### 3. email_send — Weekly digest
- `title`: "Weekly digest email"
- `description`: "One insight per week. 140-220 words."
- `channel`: 'email'
- `userAction`: 'approve'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{ emailType: 'drip_retention' }`

### 4. analytics_summary — Weekly rhythm check
- `title`: "Weekly analytics summary"
- `description`: "Summarize the week's numbers; recommended next moves
  feed next week's planner run. (Manual for now — automated summary
  deferred to a future phase.)"
- `channel`: null
- `userAction`: 'auto'
- `skillName`: null  # Phase E Day 3: skill retired
- `params`: `{}`

---

## Selection guidance

- **Every week** needs >= 1 `analytics_summary` (auto-action,
  non-intrusive).
- **audience+ weeks** need 1 `interview` or `setup_task` that pushes
  the user off-platform.
- **momentum week** should have MOSTLY prep-focused `launch_asset`
  items, not net-new content.
- **Any phase** — if `completedLastWeek` shows no posts, bump
  `content_post` count by +1 above `channelMix.{ch}.perWeek`. The
  founder skipped last week; re-plant cadence gently.

## Placeholder substitution

Strings containing `{product.name}`, `{contentPillars[N]}`,
`{recentMilestone.title}`, etc. get filled at emit time. If a
referenced field is missing, omit the placeholder rather than emit
`{...}` literally.
