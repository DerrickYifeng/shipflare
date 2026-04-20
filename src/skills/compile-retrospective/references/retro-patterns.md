# Retro patterns

One example per scope — these are the shapes a good retro takes. Not
templates to clone; anchors that show the rhythm.

## launch scope example

Input: post-launch retro, Day 5 after launch.

### whatShipped

> The public beta of ShipFlare went live on Tuesday. 347 signups in the
> first 48 hours, 12% activation rate inside the first session. Reddit
> connect + the voice-extraction pipeline shipped with the launch.

### whatWorked

> The build-in-public cadence mattered. The "one number per week" X
> posts in the two weeks before launch drove a share of traffic I
> didn't expect — the analytics show 22% of first-hour signups came
> from X posts older than 14 days. The specific numbers in those posts
> were the hook; the tagline was not.

### whatDidNot

> The first-hour email to the waitlist went out 4 hours late because I
> hadn't verified the DKIM for the sending domain until launch morning.
> Mid-tier waitlist signups (joined 3-5 days before launch) showed the
> lowest activation rate; the gap isn't explained by timing alone and
> I don't have a clean read yet.

### whatsNext

> Next 7 days: chase the activation gap with interviews of the 3-5 day
> cohort. No new features until we know what's missing.

## sprint scope example

### whatShipped

> Week of April 13-19: the reply-guy engine launched to beta accounts,
> the Today dashboard got its first real plan_items path, the
> onboarding redesign hit staging. Three feats, two meaningful fixes,
> zero incidents.

### whatWorked

> Splitting calendar posts and reply drafting into separate surfaces
> cleared up the mental model for beta users — support messages
> dropped from 4/day to 1/day without a copy change. The mental-model
> fix was worth more than the feature shipped.

### whatDidNot

> I planned 7 posts and shipped 4. The three skipped slots were all
> Tuesday slots. Worth re-thinking whether Tuesday fits my week.

### whatsNext

> Next week: put the Today feed on plan_items end-to-end. Hold
> features; make it real.

## quarter scope example

### whatShipped

> Q1 shipped the planner refresh, the reply-guy engine, and the v3
> brand token system. Onboarding got a full redesign. 14 releases total.
> MRR moved from $0 to $2,800.

### whatWorked

> The public-by-default cadence was the quarter's biggest lever.
> Founders who followed my build-in-public thread before trying the
> product activated at 2.3x the cold-signup rate. The moat isn't the
> feature; it's the relationship.

### whatDidNot

> Q1 shipped a calendar feature twice because the first version was
> structurally wrong. The first pass burned 3 weeks. If I'd done more
> thinking up front about where the calendar sits in the UX hierarchy,
> I would have skipped the first cut.

### whatsNext

> Q2: ship the plan-execute dispatcher end-to-end so the planner's
> output actually runs. One focus, twelve weeks.

## Banned phrases (all scopes)

- "crushed it"
- "on fire"
- "incredible"
- "amazing"
- "stoked"
- "blown away"
- "game-changer"
- "moving the needle"
- "swinging for the fences"
- Any exclamation point stacking

## Social digest rules

When emitting a digest:

- 400-1000 chars.
- NO headings. Single voice.
- Pull the headline from `whatShipped`'s first sentence.
- Include one number.
- Do not end with "read the full post" unless the planner supplies a
  URL; if a URL is supplied, end with it as a bare link.

Example digest from the launch retro above:

> Launched the beta of ShipFlare on Tuesday. 347 signups in 48 hours,
> 12% activation. The build-in-public thread from the prior two weeks
> drove 22% of first-hour signups — older posts with specific numbers
> aged better than any tagline. The first-hour email went out 4 hours
> late because I hadn't verified DKIM until launch morning. Next 7
> days: interviews with the 3-5-day waitlist cohort that activated
> below average.
