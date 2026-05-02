# Slop rules

Twelve patterns that fail or revise a draft. Each rule names the
matching `slopFingerprint` ID. When a draft matches a rule, append
the ID to your output's `slopFingerprint` array and surface the
matched span in `issues`.

## diagnostic_from_above (HARD FAIL)

The draft tells the OP what their situation "really" is, instead of
joining the conversation from the writer's own experience. The
fingerprint is a colon-as-wisdom opener, second-person diagnosis,
or a universal claim about what the failure mode "really" is.

**Triggers:**
- Opens with `the (real|cruel|hard|insight|trap|trick|catch)\s*[:—]`
- Uses second-person diagnosis: `you're (playing|naming|chasing|fighting|missing)`
- Closes with `that's the (moat|game|trick|trap|catch|tax|cost|truth)`
- Universal claims: `(always|never|every|most) (founders|indies|solo devs|builders)`
- Phrases naming the "real" failure point: `the real failure point`, `the real X is Y`

**BAD:** `you're playing 4 roles. the one that breaks first when the product gets real traction? always marketing — it's the only one nobody told you was critical until you're scrambling.`

**BAD:** `you're naming the real thing: marketing asks you to bet on yourself before anyone else has. the product is just the excuse. that's why month 1 feels like homework.`

**BAD:** `validated problem, zero audience after 3 months — that's the real failure point for most indies. it's not the product.`

**GOOD:** `month 2 of Glitches I was wearing all four hats and marketing was the one I kept skipping. by week 6 I had a working changelog and zero people who'd see it. fixed by setting a Friday "ship a post" recurring on my calendar.`

## no_first_person (HARD FAIL when paired with generalized claim)

The draft makes a generalized pronouncement about how the world works
but contains no `I / we / my / our / me / us` token. Per
`reply-quality-bar`, generalized claims must carry first-person
specifics from the writer's own run.

**Trigger:** draft contains any of `the real X is Y`, `the X: <wisdom>`,
`most/all/every <noun-class> do X`, `winners do X`, AND
`/\b(I|we|my|our|me|us)\b/i` does not match anywhere in the draft.

**BAD:** `the algorithm compounds early replies. your 1st post gets 0 distribution because it's cold-start. by day 3 it's useless — the algorithm's already moved on. you're not competing against 300 posts; you're competing against the distribution tax that kills new voices.`

**BAD:** `week 1–8 you ship. week 9–16 you learn distribution alone. two full learning curves stacked with no energy left for the second one.`

**GOOD:** `we tried hammering hour-1 replies for a month — bookmarks 3x'd on the days we hit the first 15 minutes. cold-starts didn't recover after day 1.`

## fortune_cookie_closer (REVISE-OR-TIGHTEN)

Tagline-style closing aphorism that pattern-matches to LinkedIn
carousel slide energy.

**Triggers:** terminal sentence matches `that's the (moat|game|trick|trap|catch|tax|cost|truth|insight|secret|key)`.

**BAD:** `... that's the moat.`

**BAD:** `... that's the real failure point for most indies.`

**GOOD:** drop the closer entirely; let the concrete anchor carry
the weight. If you can't drop it, replace with a first-person
follow-up: `... which is why I now block Friday afternoons for
nothing but writing.`

## colon_aphorism_opener (REVISE-OR-TIGHTEN)

Wisdom-as-colon opening structure.

**Trigger:** first ~30 chars match `^(the (real|cruel|hard|insight|trap|trick|catch)|here's the (real|trick|catch))[:\s—]`.

**BAD:** `the insight: 3 impressions day one wasn't the problem. it was shipping without an audience lined up. visibility isn't phase 2 — it's phase 1.`

**BAD:** `you're naming the real thing: marketing asks you to bet on yourself before anyone else has.`

**GOOD:** `3 impressions day one — felt like the algorithm was broken. turned out I shipped without an audience.`

## naked_number_unsourced (REVISE-OR-TIGHTEN)

Bare numbers paired with time / count units that read as authoritative
data without a citation. Distinct from the
`hallucinated_stats` validator (which catches `%`, `Nx`, `over N`,
`up to N`, `$N`).

**Trigger:** `\b\d+\s+(seconds|minutes|hours|days|weeks|months|years|times|posts|users|impressions|founders|comments|replies|interviews|roles)\b` AND no in-sentence citation (per the `hallucinated-stats` citation list). Also catches range forms like `week 1–8` and `day 3` when paired with no first-person grounding.

**BAD:** `week 1–8 you ship. week 9–16 you learn distribution alone. two full learning curves stacked with no energy left for the second one.`

**BAD:** `your 1st post gets 0 distribution because it's cold-start. by day 3 it's useless. you're not competing against 300 posts; you're competing against the distribution tax.`

**BAD:** `validated problem, zero audience after 3 months — that's the real failure point for most indies.`

**GOOD:** `we shipped on a Tuesday and the first paying customer landed 11 days later — way longer than the 2-day cycle I was used to in code.`

## em_dash_overuse (REVISE-OR-TIGHTEN)

Two or more em-dashes in a single reply.

**Trigger:** `text.match(/—|---| -- /g).length >= 2`

**BAD:** `your 1st post gets 0 distribution because it's cold-start. by day 3 it's useless — the algorithm's already moved on. you're not competing against 300 posts; you're competing against the distribution tax that kills new voices.`

**BAD:** `the one that breaks first when the product gets real traction? always marketing — it's the only one nobody told you was critical until you're scrambling.`

**GOOD:** rewrite as two sentences with no dashes. `cold-start kills your first post's distribution. by day 3 the algorithm's already moved on, so I started lining up 3 friends to engage in the first 15 minutes.`

## binary_not_x_its_y (HARD FAIL)

`X isn't / it's not (just) Y, it's Z` form — direct rewrite of the
2024-25 LinkedIn-Twitter aphorism template.

**Trigger:** `\b(?:it's|this is)\s+not(?:\s+just)?\s+[\w\s]{1,40}[,.—\-]+\s*(?:it's|this is|—|-)\s*[\w\s]{1,40}` or the `X isn't Y — it's Z` variant.

**BAD:** `visibility isn't phase 2 — it's phase 1.`

**BAD:** `it's not the product. it's the audience.`

**GOOD:** `I shipped before I had anyone watching. by month 3 the product worked but nobody saw it ship — that's when I started writing weekly.`

## preamble_opener (HARD FAIL)

Banned generic openers that pattern-match to bot energy.

**Trigger:** first ~20 chars match any of:
- `^\s*great (?:post|point|question|take|thread)\b`
- `^\s*(?:interesting|fascinating) (?:take|point|perspective)\b`
- `^\s*as (?:a|someone who)\b`
- `^\s*i (?:noticed|saw) (?:you|that you)\b`
- `^\s*have you considered\b`
- `^\s*absolutely[\s,.!]`
- `^\s*love this\b`

**BAD:** `great point — as someone who's been there, the real failure mode is...`

**BAD:** `interesting take. have you considered that visibility comes before product?`

**GOOD:** open with the specific anchor, not the meta. `the 3-impressions thing happened to me too — turned out I'd been posting at 11pm PT when nobody was on.`

## banned_vocabulary (HARD FAIL)

Corporate / AI-pattern vocabulary regardless of position.

**Trigger:** any of `delve, leverage, utilize, robust, crucial, pivotal, demystify, landscape, ecosystem, journey, seamless, navigate, compelling` appears (whole-word match).

**BAD:** `let's delve into the indie founder journey and demystify the marketing landscape.`

**BAD:** `the most crucial thing is to leverage your existing network.`

**GOOD:** rewrite the sentence with concrete verbs. `most of my first 50 signups came from 3 people I'd already DMed about the build — not from cold posts.`

## triple_grouping (REVISE-OR-TIGHTEN)

Three comma-separated 3+-letter words in a row, optionally with "and".

**Trigger:** `\b(\w{3,}),\s+(\w{3,}),\s+(?:and\s+)?(\w{3,})\b`

**BAD:** `clean, simple, fast`

**BAD:** `it's about consistency, authenticity, and patience.`

**GOOD:** pick one and earn it with a number. `the only one I could measure was consistency — 4 posts a week for 8 weeks before the first inbound DM.`

## negation_cadence (REVISE-OR-TIGHTEN)

Rhythmic `no X. no Y.` pair.

**Trigger:** `\bno\s+\w+[.!]\s+no\s+\w+[.!]`

**BAD:** `no fluff. no theory. just results.`

**BAD:** `no audience. no distribution. no shot.`

**GOOD:** drop the cadence and replace with one specific receipt. `the first 60 days I had 12 followers and 3 of them were people I knew — the next 30 days I was just posting into the void.`

## engagement_bait_filler (HARD FAIL)

Standalone filler replies.

**Trigger:** whole-reply match against `^(this\.?|100\s*%\.?|so true[!.]*|bookmarked|\+1|this really resonates)\s*$`

**BAD:** `this.`

**BAD:** `100%. bookmarked.`

**GOOD:** if the draft is one of these, the founder should Like the
post instead. If a substantive reply exists, lead with the specific
anchor that ties to the OP's situation.
