# Email playbook

Guidance per `emailType`. Each section gives the job-to-be-done, the tone
frame, a structural skeleton, banned phrases specific to the type, and a
tight example so the model has a concrete anchor.

## welcome

**Job:** confirm the signup and set the expectation of one specific next event.

**Tone:** warm but direct, no exclamation stacking, no generic "we're so
excited" openers. One founder writing to one person.

**Skeleton (4 beats, ~100 words):**
1. Specific confirmation line ("You're on the ShipFlare waitlist.").
2. One thing the reader should expect ("Next week I'll send the first
   build-in-public note.").
3. A question, not a CTA, to invite a reply.
4. Signature, one line, no P.S.

**Banned:** "we hope", "just wanted to", "thrilled", "team ShipFlare".

**Example body:**

> You're on the waitlist for ShipFlare. Number 142, if you're counting.
>
> Next Tuesday I'll send a short note on what we shipped last week — one
> real number, one thing that surprised us. No announcements, no teasers.
>
> Quick one: what's the one marketing task that eats the most of your week
> today? Hit reply, I read every response.
>
> — Yifeng

## thank_you

**Job:** acknowledge a specific action with a specific gratitude. Never
generic. If you can't cite what they did, you shouldn't be sending this.

**Tone:** short, personal, no CTA unless genuinely serves the reader.

**Skeleton:** 2-4 sentences. Reference the action, what it meant concretely,
optional soft next step.

**Example:**

> Thanks for the upvote on the launch — we caught it in the first 2 hours
> and it nudged us into the top 5 slot by noon. That mattered.
>
> If you hit anything rough as you try it, reply here; I'll look at it
> within the day.

## retro_week_1 / retro_launch

**Job:** weekly or post-launch reflection, first-person, numbers-forward.

**Tone:** honest, specific, lightly vulnerable. "We shipped X, Y surprised
us, Z didn't land" — not marketing theatre.

**Skeleton (5 beats, ~200 words):**
1. One lead number ("Week 1 after launch: 347 signups, 12% activation rate.").
2. Two bullets of what worked.
3. One beat of what didn't — with your best read on why.
4. What's in next week (one thing, concrete).
5. Invitation to reply with questions.

**Banned:** "crushing it", "on fire", "blown away", "incredible", "stoked".

## drip_week_1 / drip_week_2 / drip_retention

**Job:** teach one useful thing in ~2 minutes of reading. Not a feature tour.

**Tone:** newsletter voice — conversational, opinionated, with a small
contrarian edge. The reader should walk away smarter, not sold-to.

**Skeleton (4 beats, ~180 words):**
1. Open with the insight stated plainly — no teasing.
2. One specific example or mini-story that grounds it.
3. The takeaway the reader can apply this week.
4. The CTA (if `includeCTAHref` is set), framed as "if this lands, here's the
   next step" — not "click here".

**Per-week intent:**
- `drip_week_1` — the "why this problem exists" insight. Teaches the shape
  of the pain.
- `drip_week_2` — one concrete workflow or playbook the reader can steal.
- `drip_retention` — a data-driven observation from the reader's own usage
  when available, otherwise a pattern across cohorts.

## win_back

**Job:** bring back a dormant account without shame.

**Tone:** matter-of-fact. Acknowledge the absence in one clause. Then move
on to one concrete reason to come back — a feature shipped, a new result
from a cohort like theirs, or a direct offer.

**Skeleton (3 beats, ~140 words):**
1. Brief acknowledgment ("Haven't seen you on ShipFlare in a few weeks.").
2. One thing that changed since ("We shipped X — here's why that matters for
   your setup.").
3. Soft CTA that doesn't require commitment.

**Banned:** "we miss you", "come back", "your friends are using", "free
upgrade if you return".

## Subject-line conventions (all types)

- < 55 chars.
- Lowercase first word unless a proper noun. Skip most punctuation.
- Reference the concrete, not the abstract ("342 signups in 4 days", not
  "Our launch recap").
- No emoji unless the `voiceBlock` shows the user normally uses one.
- Two-clause subjects are fine ("week 1 retro — 12% activation, one regret").
