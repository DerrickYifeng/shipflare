# Angle playbook

Seven content angles used across the tactical planner + executor
skills. Each angle has a definition, 2 worked examples, and a "when to
use" note. The planner mixes angles across a week using
`thesisArc[weekIndex].angleMix`; the `draft-single-post` executor
reads the angle when writing the body.

## claim

**Definition:** A direct assertion that the reader could argue
against. Opens with the claim; the rest defends it with evidence or
analogy. No hedging, no "I think", no opening setup.

**When to use:** Week openers when the theme needs to be planted
strongly; post-launch weeks when you're arguing for a pattern shift.
Works when the founder has earned the credibility to make bold
claims.

**Example A — pre-launch, dev_tool:**
> Most "AI marketing autopilots" are built by marketers who learned
> to code. That's why they feel like CRMs. ShipFlare is built the
> other way around — by a dev who learned marketing the hard way.
> That difference lives in every corner of the product.

**Example B — compound phase, consumer:**
> The best retention tool is a user-visible change log. Readers
> open the app more when they see what shipped last week. Every
> other retention lever is downstream of this.

## story

**Definition:** A specific first-person incident with a clear arc.
Beginning / middle / end compressed into 280-1200 chars. No lesson
spelled out at the end — let the incident carry the weight.

**When to use:** Early-week humanizers; any week the thesis needs a
concrete ground beneath it. The story should be true and specific.

**Example A — foundation phase:**
> Last Tuesday I spent 40 minutes writing a tweet about an API
> choice that took me 10 minutes to make. That's when I started
> building ShipFlare. Writing about shipping shouldn't take longer
> than shipping.

**Example B — compound phase:**
> A customer emailed me last week about a feature I didn't know
> anyone used. Turns out she's rescheduled 23 posts with it. I
> reviewed the commit that shipped it — the PR title was "tiny UX
> fix". The small things are the product.

## contrarian

**Definition:** Stated-against framing. Starts with a popular belief,
rejects it, gives a specific reason. High risk, high reward — don't
pick fights you can't defend.

**When to use:** Mid-week when the audience needs a jolt; momentum
phase when you're trying to be remembered. Never on a week where
the thesis isn't already grounded in a prior post.

**Example A — saas:**
> Everyone says founders should post daily. I stopped posting
> daily a month before launch and my activation rate tripled.
> Daily posts train the audience to skim. Three specific posts a
> week teach them to read.

**Example B — ai_app:**
> "AI will eventually do this reliably" is the most expensive
> sentence in any AI app's roadmap. Pick what you can do today
> within five percent of perfect. Wait for the rest.

## howto

**Definition:** Imperative walkthrough — "here's how I do X in five
steps". Each step is concrete and independently verifiable.

**When to use:** Audience phase when you're building "useful founder"
credibility; any week where `currentPhase = audience` and the
theme lends itself to a playbook.

**Example A — creator_tool:**
> How I prep a launch video in under an hour:
> 1. Record the product doing one thing, no voiceover.
> 2. Pull three frames that show the outcome.
> 3. Write captions that describe what the viewer sees.
> 4. Cut to 30 seconds around the best frame.
> 5. End card with tagline + date. Done.

**Example B — saas:**
> How I run customer interviews in week 3 of onboarding:
> 1. Filter to users with ≥ 3 active days.
> 2. DM with one specific product observation about their account.
> 3. 15-minute call, one open question per minute.
> 4. Record whatever they say after minute 12 — that's where the
>    real thing lives.
> 5. Write the notes the same hour or lose them.

## data

**Definition:** A specific number + the reader-facing implication.
Lead with the metric; unpack why it matters. No charts in the post —
the number IS the chart.

**When to use:** Momentum phase when social proof accumulates;
post-launch weeks when you have real numbers. Always verified — a
wrong data post costs more than a generic one.

**Example A — momentum phase, dev_tool:**
> 342 waitlist signups in four days. 68% came from a single post
> that went up at 5pm EST on a Tuesday. Timing is not a lever; the
> post is.

**Example B — compound phase, saas:**
> Week-2 retention: 62%. Higher than we expected because the
> onboarding checklist drove activation in session one. The
> in-app tooltips we spent a week on drove zero measurable lift.

## case

**Definition:** One named user's specific outcome with their consent.
Reader-facing generalization in the last sentence. Hardest angle to
fake — either you have a customer or you don't.

**When to use:** Compound / steady phase where retention proof
matters; any week the thesis argues for an outcome you can point at.

**Example A — agency:**
> A partner agency replaced four hours of weekly reporting with a
> ShipFlare scheduled digest. They didn't ask for it — they just
> stopped doing the old thing. That's the bar for whether a tool
> has actually displaced the workflow.

**Example B — ai_app:**
> An indie dev we've been working with had GPT-4o answer 60% of
> his support inbox. The other 40% were the ones worth his time.
> Good AI lets you focus on the questions that need a human.

## synthesis

**Definition:** Pattern-across-many. Draws from 3+ specific data
points to name a trend. "I talked to 20 founders this week, here's
the pattern." Earns authority by width.

**When to use:** End-of-week summary posts; weeks where the founder
has been heads-down interviewing or surveying. Rare — don't fake the
breadth.

**Example A — saas, audience phase:**
> Twelve customer interviews this month, one pattern: every SaaS
> founder I talked to has a weekly "marketing Friday" they dread.
> It's the day nothing ships and posting feels performative.
> ShipFlare kills Friday as a category.

**Example B — creator_tool:**
> Across 30 creators using the new export flow: the ones who
> shared their output same-day had 3x the re-engagement the
> following week. The delay between creation and share is a
> retention killer. Shorten it.

## Default mix per phase

When a week's `angleMix` isn't specified, the planner may fall back to
these defaults:

- **foundation** → story + claim + contrarian (build identity)
- **audience** → howto + data + story (build useful credibility)
- **momentum** → data + case + claim (drive pre-launch proof)
- **launch** → story + claim + data (narrate the day)
- **compound** → case + data + synthesis (convert launch audience)
- **steady** → synthesis + howto + story (sustain rhythm)

## Angle combinations to avoid in one week

- 3+ `claim` — reads as ranty
- 3+ `data` — reads as dashboard
- 3+ `howto` — reads as content marketing
- All three of `claim` / `contrarian` / `synthesis` in one week —
  exhausting, overstates the founder's point of view
