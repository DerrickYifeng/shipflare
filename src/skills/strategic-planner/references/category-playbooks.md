# Category playbooks

Per-category narrative defaults. Look up the input's
`product.category`, apply the matching section. For `other`, hedge —
extract the nearest neighbor from the first three playbooks rather than
mashing together a bland composite.

Each playbook is prescriptive, not reportage. The archetype line is the
angle the thesis should land on. The pillars are candidate topics the
product can own credibly. The channel mix is the starting cadence (the
agent can tune ±1 per week based on state). The avoid list is
category-specific bait the agent must not write into the narrative.

---

## dev_tool

**Archetype:** Dev tools win by demonstrating technical credibility
through specific, verifiable build-in-public. The founder's thesis is
almost always an engineering-tradeoff argument, not a marketing claim.

**Candidate content pillars (pick 3-4):**
- `build-in-public` — shipped milestones with concrete numbers
  (tests green, latency budgets hit, benchmark wins).
- `tooling-counterfactuals` — what you tried, what didn't work, why
  you chose the stack you have.
- `solo-dev-ops` — the unglamorous work (CI, staging, monitoring)
  framed as founder-experience content.
- `devex-takes` — opinionated reads on API design, CLI ergonomics,
  docs.
- `under-the-hood` — walkthroughs of one subsystem, screenshot-heavy.

**Channel mix defaults:**
- `x.perWeek`: 4-6 (audience), 5-7 (momentum).
- `x.preferredHours` (UTC): `[14, 17, 21]` (mid-day EST, late EST, Europe evening).
- `reddit.perWeek`: 1-2.
- `reddit.preferredCommunities`: `['r/SideProject', 'r/indiehackers',
  'r/programming', 'r/webdev']`, plus a category-specific sub if the
  product is language-bound (`r/rust`, `r/golang`, etc.).
- `email.perWeek`: 0-1 (foundation), 1 (audience onward).

**Avoid:**
- "The future of {noun}". Dev readers will roll their eyes.
- Marketing-speak benefits ("boost productivity", "seamless"). Engineers
  want mechanism, not adjectives.
- Bragging about scale before the product has real users. Dev audiences
  smell it.

---

## saas

**Archetype:** SaaS (business-facing) products win by naming a specific
job-to-be-done and owning the before/after delta for a specific ICP.
The thesis points at the workflow shift, not the feature list.

**Candidate content pillars (pick 3-4):**
- `customer-patterns` — the shape of how customers actually use the
  tool, generalized.
- `metric-stories` — one customer's specific delta (MRR, retention,
  time-to-onboard) with the real number.
- `playbooks` — opinionated workflows the product enables.
- `anti-patterns` — what the category gets wrong (without naming
  competitors directly).
- `founder-notes` — pricing decisions, positioning pivots, the
  why-now.

**Channel mix defaults:**
- `x.perWeek`: 4-5 (audience), 5-7 (momentum).
- `x.preferredHours` (UTC): `[13, 15, 18]` (EST business hours).
- `reddit.perWeek`: 1. SaaS often has weaker Reddit fit than dev tools.
- `reddit.preferredCommunities`: `['r/SaaS', 'r/startups',
  'r/Entrepreneur']` plus one vertical sub if the ICP is industry-bound.
- `email.perWeek`: 1 (audience onward). Email matters more for SaaS
  than dev tools — ICPs live in inboxes.

**Avoid:**
- "Enterprise-grade" — meaningless without the concrete security /
  compliance proof.
- Generic "productivity" framing. Name the workflow.
- Screenshots without a specific caption that frames what the reader
  should notice.

---

## consumer

**Archetype:** Consumer apps win by naming a ritual or felt moment that
the product fits into. The thesis is about the emotion / habit, not
the feature. Voice tends more personal and less analytical.

**Candidate content pillars (pick 3-4):**
- `user-rituals` — how real users weave the product into a day/week.
- `small-wins` — one-sentence user stories that anchor the promise.
- `the-anti-pattern-we-saw` — the bad habit the product lets you escape.
- `community-voices` — lightly edited user quotes, always attributed.
- `founder-diary` — why-we-built-this in a human register.

**Channel mix defaults:**
- `x.perWeek`: 3-5. Consumer apps often find Instagram / TikTok / email
  more productive than X; X is the build-in-public channel, not the
  acquisition channel here.
- `x.preferredHours` (UTC): `[14, 21]` (lunch + evening).
- `reddit.perWeek`: 0-1. Many consumer subs forbid self-promotion;
  check `fetch-community-rules` before scheduling.
- `reddit.preferredCommunities`: `['r/productivity', 'r/selfhelp',
  'r/getdisciplined']` or category-native subs.
- `email.perWeek`: 1-2 (audience onward). Weekly cadence is the habit
  surface for consumer apps.

**Avoid:**
- Analytical / B2B-flavored language ("ROI", "funnel", "conversion").
- Overclaiming lifestyle transformation from a single product.
- Talking about the founder's journey without rooting it in user
  stories.

---

## creator_tool

**Archetype:** Creator tools win by demonstrating the output — the thing
a creator makes WITH the tool is more compelling than the tool itself.
The thesis is "here's what becomes possible", not "here's what we built".

**Candidate content pillars (pick 3-4):**
- `output-showcase` — the artifact the tool produced, with the creator's
  context.
- `creator-workflows` — the end-to-end process, tool included as one
  step.
- `craft-takes` — opinions on the medium the tool supports
  (typography, editing, design, etc.).
- `behind-the-scenes` — founder explaining a tricky rendering /
  export / generative problem.
- `community-shoutouts` — featured creators using the product.

**Channel mix defaults:**
- `x.perWeek`: 4-6. Creators live on X; expect higher engagement.
- `x.preferredHours` (UTC): `[15, 20, 23]` — when creators post their
  own work.
- `reddit.perWeek`: 1. Creator subs are very self-promotion aware.
- `reddit.preferredCommunities`: medium-specific
  (`r/graphic_design`, `r/writing`, `r/videoediting`, etc.).
- `email.perWeek`: 1 (audience onward) with one meaty weekly digest
  beat.

**Avoid:**
- Talking about the tool in isolation. Always frame output-first.
- "10x your creativity" and similar quantifications of craft.
- Showing the app UI instead of the artifact the app produced.

---

## agency

**Archetype:** Agency-style products (or tools aimed at agency
workflows) win by demonstrating the shipped-in-minutes-not-weeks delta
and naming the specific agency workflow you replace. The thesis names
the manual labor evaporating.

**Candidate content pillars (pick 3-4):**
- `client-case-studies` — one agency's delta with the product,
  attributable when the agency consents.
- `workflow-replacement` — the manual process you shortened, shown
  in under 60 seconds of video or 3 screenshots.
- `pricing-literacy` — what the category charges, where the product
  lands, what you're NOT including.
- `margin-math` — hourly rates vs tool cost, told in the agency
  owner's voice.
- `partner-plays` — how the product sits inside the partner
  ecosystem.

**Channel mix defaults:**
- `x.perWeek`: 3-5. Agency founders live on LinkedIn more than X — but
  the build-in-public arc still runs on X.
- `x.preferredHours` (UTC): `[13, 17]`.
- `reddit.perWeek`: 1. Agency subs like `r/agency` are small but
  high-signal.
- `reddit.preferredCommunities`: `['r/agency', 'r/freelance']` plus
  `r/smallbusiness`.
- `email.perWeek`: 1-2. Agency ICPs read email.

**Avoid:**
- Vague "save time" claims without an hours/week number.
- Name-dropping enterprise clients you don't have.
- Writing as-if the product is AI magic; agency buyers are skeptical
  of hand-wave claims.

---

## ai_app

**Archetype:** AI apps win by being specific about WHAT the AI does
well and WHERE it fails. Thesis is a credible narrow claim + explicit
limits, not "AI-powered everything". Honest bounds build trust.

**Candidate content pillars (pick 3-4):**
- `model-tradeoffs` — which models the product uses, why, at what cost.
- `failure-modes` — what the product refuses to do / where it's
  unreliable, explicit.
- `prompt-craft` — opinions on prompt design / retrieval / eval
  pipelines.
- `end-to-end-demos` — one real task, full transcript, including
  warts.
- `vibes-check` — qualitative user reports on voice / output quality.

**Channel mix defaults:**
- `x.perWeek`: 5-7. AI audiences are X-heavy and reward high cadence
  in the right voice.
- `x.preferredHours` (UTC): `[14, 17, 22]`.
- `reddit.perWeek`: 1-2. `r/LocalLLaMA`, `r/singularity`, `r/OpenAI`
  if relevant.
- `reddit.preferredCommunities`: `['r/LocalLLaMA', 'r/MachineLearning',
  'r/singularity']` or `['r/ChatGPT', 'r/OpenAI']` depending on
  niche.
- `email.perWeek`: 1 (audience onward).

**Avoid:**
- "Revolutionary" or "breakthrough" language — AI audience is
  allergic.
- Overstating novelty when the underlying model is the commodity.
- Ignoring cost / latency / failure-rate math in public posts. AI
  readers notice when it's missing.

---

## other

**Archetype:** Unknown category. Narrow the arc to the product's stated
value prop + the founder's visible voice. Hedge on category-specific
plays.

**Candidate content pillars (pick 3):**
- `build-in-public` — generic but safe.
- `founder-notes` — first-person, matches any voice.
- `customer-voice` — once the product has users, lift their framing.

**Channel mix defaults:**
- `x.perWeek`: 3-4 (foundation / audience), 5-6 (momentum).
- `x.preferredHours` (UTC): `[14, 18]`.
- `reddit.perWeek`: 0-1. Only if the founder has a specific sub in
  mind; don't guess.
- `email.perWeek`: 1 max.

**Avoid:**
- Anything that sounds like you picked the category at random. The
  narrative should name the actual product.
- Copying a more-confident category's playbook wholesale.
