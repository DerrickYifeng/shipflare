# Thread quality rules — per-candidate scoring

You are judging **a single question per thread**: should the founder reply
here? You are not ranking, scoring, or summarizing — you are making a
binary `keep` call plus a 0–1 confidence `score`.

This file is the **single source of truth** for "is this thread relevant
for THIS founder's product?" Discovery, reply drafting, and product-mention
gating defer to this file when the input exposes the same signals (tweet
text, author handle, bio, follower count, product context).

## What "keep" means

A thread earns `keep: true` when **all three** are true:

1. **Author identity passes the gates** below (§ Author identity gates).
2. **There is a real opening for a reply.** The author is asking a
   question, venting a pain, evaluating a solution, or sharing a problem
   the product could touch. A celebratory post, meme, or thread that's
   already resolved is not an opening.
3. **The reply would be welcome.** The thread is recent enough, the
   audience is large enough to be worth the effort, and the subculture
   norms accept replies from product operators.

If any one of those is missing → `keep: false`.

---

## Author identity gates

When the input includes an author bio (X discovery, post-search), apply
these gates BEFORE looking at the tweet text. When the bio is null
(`fetchUserBios` couldn't resolve, or the platform doesn't expose one),
fall back to text-only signals from the tweet itself.

**Default: PASS.** Replying under most accounts is net-positive exposure.
Only block when the product context gives a specific reason to.

### Block (verdict: keep=false) when ANY of these apply

**A. Direct category competitor of the product.**
The author's *primary* identity is a product/service that competes head-on
with what the founder is building. Example: a SaaS marketing-attribution
tool's founder posts daily; the user's product is a marketing-attribution
tool too — replying under their threads funnels the user's audience to the
competitor. Tag this in `signals` as `competitor_bio`.

**B. Pure-grift identity in the product's vertical.**
A commodity-info creator whose monetization is an info-product (course,
cohort, coaching package, newsletter funnel, service package) with no
underlying product *in the same vertical the user is targeting*, AND
replying under their posts plausibly exposes the user to people already
saturated with paid offerings overlapping the user's. The "in the same
vertical" qualifier is what flips this gate — see § Calibration.
Tag as `grift_in_vertical`.

**C. Universal-spam patterns** (block regardless of product). These are
bad reply targets for ANY product:

- Lead-gen / MLM funnels with a $-amount-per-period claim
  (`"make $10k/mo"`, `"make $500/day"`, `"financial freedom in 30 days"`)
  → tag `lead_gen_funnel`
- DM-to-earn funnels (`"DM me to learn how to make $X"`)
  → tag `dm_funnel`
- Engagement-pod / follow-game accounts (`"engagement pod"`, `"follow back"`,
  `"f4f"`, `"follow4follow"`) → tag `engagement_pod`
- Crypto / web3 pump-and-shill bots (`"airdrop"`, `"100x gem"`,
  `"shitcoin"`, `"degen plays"`, `"web3 alpha/whale/signals"`)
  → tag `crypto_shill`
- Adult / OF promo (`"OnlyFans creator"`, `"OF promo"`)
  → tag `adult_promo`
- Pure-emoji bios (3+ leading emoji with no actual identity text:
  `"🎯💰🚀"`) → tag `emoji_bio`

### Explicitly PASS — do not block

- **Hybrid operators.** Author runs a real product/service AND has a
  podcast / newsletter / community / content brand on the side. Hybrid
  identity is normal across every vertical.
- **Fund / VC / holdco / agency operators** with real portfolio work.
- **Audience-overlap creators.** Coaches, service-providers, info-creators
  whose audience IS the user's ICP. If the user's product *serves* them,
  they're a valuable reach, not a competitor — even if they sell a course.
- **Ambiguous bios.** When you cannot unambiguously categorize the bio
  against THIS product, pass. Downstream safeguards exist for bait content.

### Calibration

The same bio flips with the product:

- "copywriter teaching you to write" — competitor for a SaaS tool aimed at
  SaaS founders; **ICP** for an AI-writing-assistant whose users *are*
  writers. The verdict tracks the product, not the bio.
- "builds & sells courses about marketing" — competitor for a marketing-
  course platform; **valuable reach** for an analytics tool whose users
  are marketing-course buyers.

Read the product description carefully before each judgment.

### When the bio is null

`fetchUserBios` returns `bio: null` when the bio is unresolvable (deleted
account, brand-new account, rate limit, timeout). In that case:

- Skip the bio gates entirely.
- Apply text-only judgment from the tweet body.
- If the tweet itself contains universal-spam tells (course funnel pitch,
  pump-and-dump shill, "DM me to make $X"), mark `keep: false` on text
  alone.
- Otherwise, default to evaluating the opening + welcome conditions below
  as if the author were neutral. Cold-start bias still applies.

---

## Positive signals on the tweet (lean toward keep=true)

- Author explicitly asks for tool recommendations / alternatives in the
  product's category → tag `help_request`, `in_domain`
- Author describes a workflow the product directly addresses → tag
  `workflow_match`
- Author is a solo founder / bootstrapper / IC / builder publishing
  product updates (matches most ShipFlare-style ICPs) → tag `solo_founder`
- Post has a specific problem statement, not a vague complaint → tag
  `specific_problem`
- Post is < 72h old on X, < 7d old on Reddit (older → audience has
  moved on)
- Moderate engagement (2-50 replies on X, 5-200 comments on Reddit) —
  enough audience, not a zoo

## Negative signals on the tweet (lean toward keep=false)

- Post is vague, ragebait, or purely venting with no problem to solve
  → tag `ragebait`
- Post is already resolved in-thread by another commenter → tag
  `already_resolved`
- Thread has 200+ replies on X or 500+ comments on Reddit — signal
  lost, your reply won't be seen → tag `signal_lost`
- Thread is > 2 weeks old (X) or > 30 days old (Reddit) — necro reply
  → tag `stale`
- Author has < 50 followers (X) or < 100 karma (Reddit) — audience too
  small to justify the effort → tag `audience_too_small`
- Post is in a language you cannot read confidently → tag
  `language_unreadable`
- `is_repost: true` AND `original_author_username` is null — unreplyable
  → tag `repost_unreplyable`

---

## Gray zone — default keep=false, note the ambiguity

When you genuinely cannot tell, **set `keep: false` with `score` ≤ 0.5**
and explain in `reason` what you'd need to see to flip it. Do NOT keep
speculatively. Downstream feedback (reviewer + the user's own
approve/skip) will correct false-skips over time; false-keeps erode
trust immediately.

## Confidence calibration

- **≥ 0.85** — obvious signal, you'd bet your turn on this
- **0.6 – 0.85** — clear signal but some missing context (e.g., bio
  not visible, thread thin on detail)
- **0.3 – 0.6** — ambiguous; the verdict could flip on a single
  additional data point
- **≤ 0.3** — you're guessing; prefer `keep: false` with a low score
  rather than emitting a low-confidence keep that poisons feedback memory

## How `reason` should read

One or two sentences that name the **specific product signal** that
drove the verdict — not a generic summary of the post. When the bio
gates triggered the call, name the gate and the signal you saw.

Good: "Solo founder asking 'how do you actually get your first users'
— exact ICP, clear pain, recent post with room in thread."

Good (bio-gate skip): "Direct category competitor — bio describes a
SaaS marketing-attribution tool, same vertical as the user's product."

Good (universal-spam skip): "Bio is engagement-pod operator
('follow back, f4f') — universally bad reply target."

Bad: "Looks like a relevant tweet about marketing."

The founder, the reviewer, and future-you reading memory distillations
all need to be able to reconstruct your reasoning from `reason` alone.

## Cold-start bias

If the caller's context notes that MemoryStore is empty (no prior
approve/skip labels), be **conservative**: prefer `keep: false` on
borderline cases. It is cheaper for the product to miss 10 candidates
than to keep 2 bad ones — bad keeps train the founder to ignore the
Today page.

---

# canMentionProduct decision (run alongside the keep verdict)

You also decide whether a reply targeting this thread may mention the product.
Apply the rules below to fill `canMentionProduct` + `mentionSignal` on every
verdict — even when `keep: false` (set `mentionSignal: 'no_fit'` in that case).

## canMentionProduct — green-light signals → `true`

The OP must have invited the mention. Choose the strongest signal:

- **`tool_question`** — OP literally asks "what do you use for X?" /
  "recommend a tool for Y" / "best stack for Z" AND the product
  plausibly fits the ask. The post must be a question, not an
  observation.
- **`debug_problem_fit`** — OP is debugging a specific problem this
  product solves, with specificity (named stack, named symptom).
  Generic complaints don't qualify.
- **`competitor_complaint`** — OP names a direct competitor or
  competitor class and complains about a SPECIFIC failure mode
  (not "X is bad" — has to be "X does <thing> and it broke
  <my use case>").
- **`case_study_request`** — OP asks for examples / case studies /
  success stories in the product's space.
- **`review_invitation`** — OP offers teardown / review / feedback
  swap.

When a green-light fires AND the product plausibly answers the OP's
need AND your internal confidence is ≥ 0.6 → set
`canMentionProduct: true`. Even under green-light, only mention the
product when the natural phrasing of the answer needs it — never
bolt the pitch onto an unrelated reply.

## canMentionProduct — hard-mute signals → `false`

If any of these fire, suppress the mention regardless of any
green-light:

- **`milestone_celebration`** — revenue, user count, years,
  anniversaries. Pitching into a celebration reads predatory.
- **`vulnerable_post`** — burnout, doubt, grief, "close to giving
  up", "first churn hurt more than I expected".
- **`grief_or_layoff`** — job loss, company death, personal hardship.
- **`political`** — political takes, culture war, social-issue posts.
- **`no_fit`** — no green-light or hard-mute signal fires; the OP
  isn't asking for a tool and isn't in a sensitive emotional
  register. Default to suppression.

## Strictness — when in doubt, suppress

- False-negatives (missed plug opportunity) are cheap — the founder
  still got an on-brand reply, they just didn't get an inline
  mention.
- False-positives (pitching into a vulnerable post, into a political
  thread, or into someone celebrating) cost reputation in a way
  that's hard to undo.

If you can't pick a green-light signal with internal confidence
≥ 0.6, default `canMentionProduct: false`. The reply still ships
(if the gates passed); it just stays generic on the product front.

## Examples

### Green-light: tool_question

> "anyone got a good way to keep my X drafts organized? tried
> notion, airtable, hated both."

Signal: `tool_question`. Gates pass. `canMentionProduct: true` —
OP literally asks for a tool in the product's domain.

### Green-light: debug_problem_fit

> "spent 6 hrs trying to figure out why my drafts keep losing
> their voice when the agent regenerates them"

Signal: `debug_problem_fit`. Gates pass. `canMentionProduct: true`
when the product addresses that exact symptom — anchor on the
specific fix, not a marketing pitch.

### Hard-mute: vulnerable_post

> "first churn hit today and I'm gutted"

Signal: `vulnerable`. Gates may still pass (this is exactly the
kind of thread where a peer reply matters), but
`canMentionProduct: false`. The drafter should write a supportive
reply with no product reference.

### Hard-mute: milestone_celebration

> "we just crossed $10k MRR — 14 months of grinding"

Signal: `milestone`. Even though the founder is in the same
space, pitching here reads as opportunistic.
`canMentionProduct: false`.

### No-fit (Gate 1 fails)

> "spring is officially here in nyc 🌸"

Signal: `no_fit`. Gate 1 fails (author isn't a potential user in
this moment). `pass: false`, `gateFailed: 1`,
`canMentionProduct: false`.

### Borderline: weak green-light → suppress

> "thinking about switching off twitter completely. anyone tried
> reddit instead?"

Could read as `tool_question`, but the platform-vs-platform
framing carries political-ish "leaving X" sentiment and confidence
sits below 0.6. `canMentionProduct: false` — natural reply is
about platform mechanics, not pitching.
