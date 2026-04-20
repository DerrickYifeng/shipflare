# Milestone → thesis

How to turn `recentMilestones` into a thesis that survives 6 weeks of
content. Four strategies; pick the one that best matches the signal in
the input. When there are no milestones at all, use strategy 4.

## 1. New feature → "Why {feature} matters" (claim angle)

**When:** The most recent milestone is a `commit`, `pr`, or `release`
that shipped a user-visible capability. Most common strategy.

**Method:**
- Extract the capability in one clause ("split posts and replies into
  separate channels").
- Ask: what is the reader's default assumption that this capability
  refutes? ("Calendars are for scheduling one stream of content" →
  refuted by "the reply stream needs its own cadence").
- Thesis is the refutation, stated as a claim the next 6 weeks argue
  for.

**Example:**
- Milestone: "Reply-guy engine: 15-min reply window for target accounts"
- Thesis: "The reply stream is its own discipline — if you're treating
  it as a side pipeline to your calendar, you're leaving the algo's
  15-minute window on the table every day."

## 2. Customer win → "What {customer} discovered" (case angle)

**When:** The milestone (or founder note) describes a specific customer
outcome — MRR, retention, unexpected use case. Often not a commit at
all — pulled from a support ticket or interview note.

**Method:**
- Identify the specific thing the customer did that broke the default
  pattern.
- Thesis generalizes: this is what the product enables for a specific
  kind of user, stated as a claim.

**Example:**
- Customer signal: "A solo consultant used the calendar pass to
  schedule 3 weeks of posts in 20 minutes, then stayed offline for
  the week."
- Thesis: "Solo founders don't need more marketing — they need
  marketing that doesn't require them. The calendar is off if the
  founder is off."

## 3. Incident / wrong turn → "Why we stopped doing X" (contrarian angle)

**When:** A milestone or recent decision represents undoing prior
work — a feature removed, a pattern abandoned, a pivot. These build
credibility through honesty.

**Method:**
- State the thing you stopped doing in one clause ("we stopped
  pretending the planner could be fully autonomous").
- Thesis names the principle that broke the prior approach.

**Example:**
- Signal: The team removed auto-posting and replaced it with a 20-min
  approval queue.
- Thesis: "Marketing autopilot is the wrong frame. What founders want
  is a competent intern they check once a day — not a colleague who
  posts without asking."

## 4. No signal → contentPillars rotation (default)

**When:** `recentMilestones` is empty, or every entry is chore-level
(deps, refactors, docs without shipped capability). Common for the
first 1-2 weeks after onboarding when the founder hasn't shipped yet
under ShipFlare.

**Method:**
- Do not fabricate a milestone thesis. Anchor the thesis in the
  product's value prop + targetAudience instead.
- The thesis is a short restatement of the product's wedge in
  contentPillars-compatible framing. It's weaker than the first three
  strategies, which is fine — the planner narrative should note that
  Week 1's theme will likely rotate once shipping signals return.

**Example:**
- Value prop: "Marketing autopilot for indie devs."
- Audience: "Solo founders shipping weekly."
- Thesis: "Solo devs are drowning in marketing debt. You ship in the
  time it takes to post about what you shipped."

## Which strategy when

- Strategy 1 is the default for active-shipping products.
- Strategy 2 when the founder mentions a specific customer story in
  the interview step of onboarding, OR when analytics surfaces a
  high-outlier user behavior.
- Strategy 3 is rare but powerful post-launch (compound / steady
  phase), when the arc has real decisions to surface.
- Strategy 4 only when the signal genuinely isn't there. NEVER use
  it to avoid the work of diagnosing a signal that IS there.

## Quality checks

Your thesis should pass all of these:

- **Specific:** a reader could argue against it. "Marketing matters"
  is not a thesis. "Solo founders post too much about the tool and
  not enough about the customer" is a thesis.
- **Survives 6 weeks:** the claim is broad enough that every week of
  `thesisArc` can anchor a sub-claim to it.
- **Not a feature list:** the thesis is about the world, not about
  what the product does.
- **Sounds like the founder:** when `voiceProfile` is set, the thesis
  uses the founder's tics — contractions, sentence length,
  vocabulary. If it reads like a press release, rewrite.
