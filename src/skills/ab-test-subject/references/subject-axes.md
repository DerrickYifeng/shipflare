# Subject-line axes

Every A/B variant pair should diverge on at least one of these axes. Picking
two axes at once is fine — picking zero is a contract violation.

## Axis 1 — opener

- **verb-forward**: starts with a command or strong verb. "start here",
  "stop tracking X", "read this before launch day".
- **number-forward**: leads with a specific quantity. "342 signups in 4 days",
  "12% activation after week 1".
- **entity-forward**: leads with a named thing — product, company, person.
  "Product Hunt maker comment that worked".

Pick any two different openers. Do not pair verb-forward with another
verb-forward.

## Axis 2 — specificity

- **concrete**: names one outcome, one metric, one time window. Works for
  post-launch retros and cohort-specific drips.
- **broad**: abstract enough to pull curious skimmers. Works for
  foundation-phase lists where the reader doesn't know the product yet.

Pair one concrete with one broad when the cohort spans awareness levels.

## Axis 3 — length

- **short**: ≤ 28 chars. Mobile-first inboxes truncate at ~33; short wins on
  phones.
- **full**: 40-55 chars. Reveals more on desktop clients, supports a
  two-clause construction.

Don't go below 14 chars — it reads as spam.

## Axis 4 — framing

- **reader-facing**: centers the reader's world. "your first 5 tweets",
  "what Friday shipped looks like".
- **builder-facing**: centers the founder's perspective. "what shipped this
  week", "our first 200 signups".

Pair reader-facing with builder-facing when the cohort is early and both
voices may resonate.

## Examples of good pairs

### Retro_launch, axis = specificity

- A: "Week 1 retro — 347 signups, 12% activation" (concrete)
- B: "What I learned shipping week 1" (broad)

### Drip_week_1, axis = opener + framing

- A: "stop writing tweets on Sunday nights" (verb + reader)
- B: "342 founders changed when they post" (number + builder)

### Welcome, axis = length

- A: "you're on the list" (13 chars — short)
- B: "welcome to ShipFlare — here's what's next" (42 chars — full)

## Anti-patterns (both variants must avoid)

- Numbered listicles with round numbers. "5 ways to grow your audience".
- All-caps anywhere unless a product name is all-caps.
- Ellipsis teasers. "This one thing changed everything…".
- Vague urgency. "Read this now", "Don't miss out".
- Emoji stacking. One emoji max, only if `voiceBlock` shows habitual use.
