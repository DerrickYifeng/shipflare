# Judgment rubric

You are judging **a single question per thread**: should the founder reply
here? You are not ranking, scoring, or summarizing — you are making a
binary call plus a confidence.

This rubric is the **single source of truth** for "is this thread relevant
for THIS founder's product?" Every layer downstream — discovery, reply
drafting, product-mention gating — defers to this file when the input
exposes the same signals (tweet text, author handle, bio, follower count,
product context). When you see one of those signals, judge it here.

## What "queue" means

A thread earns `queue` when **all three** are true:

1. **Author identity passes the gates** below (§ Author identity gates).
2. **There is a real opening for a reply.** The author is asking a
   question, venting a pain, evaluating a solution, or sharing a
   problem the product could touch. A celebratory post, meme, or
   thread that's already resolved is not an opening.
3. **The reply would be welcome.** The thread is recent enough, the
   audience is large enough to be worth the effort, and the subculture
   norms accept replies from product operators.

If any one of those is missing → `skip`.

---

## Author identity gates

When the input includes an author bio (X discovery, post-search), apply
these gates BEFORE looking at the tweet text. When the bio is null
(`fetchUserBios` couldn't resolve, or the platform doesn't expose one),
fall back to text-only signals from the tweet itself.

**Default: PASS.** Replying under most accounts is net-positive exposure.
Only block when the product context gives a specific reason to.

### Block (verdict: skip) when ANY of these apply

**A. Direct category competitor of the product.**
The author's *primary* identity is a product/service that competes head-on
with what the founder is building. Example: a SaaS marketing-attribution
tool's founder posts daily; the user's product is a marketing-attribution
tool too — replying under their threads funnels the user's audience to the
competitor.

**B. Pure-grift identity in the product's vertical.**
A commodity-info creator whose monetization is an info-product (course,
cohort, coaching package, newsletter funnel, service package) with no
underlying product *in the same vertical the user is targeting*, AND
replying under their posts plausibly exposes the user to people already
saturated with paid offerings overlapping the user's. The "in the same
vertical" qualifier is what flips this gate — see § Calibration.

**C. Universal-spam patterns** (block regardless of product). These are
bad reply targets for ANY product:

- Lead-gen / MLM funnels with a $-amount-per-period claim
  (`"make $10k/mo"`, `"make $500/day"`, `"financial freedom in 30 days"`)
- DM-to-earn funnels (`"DM me to learn how to make $X"`)
- Engagement-pod / follow-game accounts (`"engagement pod"`, `"follow back"`,
  `"f4f"`, `"follow4follow"`)
- Crypto / web3 pump-and-shill bots (`"airdrop"`, `"100x gem"`,
  `"shitcoin"`, `"degen plays"`, `"web3 alpha/whale/signals"`)
- Adult / OF promo (`"OnlyFans creator"`, `"OF promo"`)
- Pure-emoji bios (3+ leading emoji with no actual identity text:
  `"🎯💰🚀"`)

### Explicitly PASS — do not block

- **Hybrid operators.** Author runs a real product/service AND has a
  podcast / newsletter / community / content brand on the side. Hybrid
  identity is normal across every vertical.
- **Fund / VC / holdco / agency operators** with real portfolio work.
- **Audience-overlap creators.** Coaches, service-providers, info-creators
  whose audience IS the user's ICP. If the user's product *serves* them,
  they're a valuable reach, not a competitor — even if they sell a course.
- **Ambiguous bios.** When you cannot unambiguously categorize the bio
  against THIS product, pass. The community-manager / x-reply-writer has
  downstream safeguards for bait content (R8 register check).

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

`fetchUserBios` returns `bio: null` when Grok cannot resolve the handle
(deleted account, brand-new account, rate limit, timeout). In that case:

- Skip the bio gates entirely.
- Apply text-only judgment from the tweet body.
- If the tweet itself contains universal-spam tells (course funnel pitch,
  pump-and-dump shill, "DM me to make $X"), skip on text alone.
- Otherwise, default to evaluating gates 2 and 3 below as if the author
  were neutral. Cold-start bias still applies.

---

## Positive signals on the tweet (lean toward queue)

- Author explicitly asks for tool recommendations / alternatives in the
  product's category
- Author describes a workflow the product directly addresses
- Author is a solo founder / bootstrapper / IC / builder publishing
  product updates (matches most ShipFlare-style ICPs)
- Post has a specific problem statement, not a vague complaint
- Post is < 72h old on X, < 7d old on Reddit (older → audience has
  moved on)
- Moderate engagement (2-50 replies on X, 5-200 comments on Reddit) —
  enough audience, not a zoo

## Negative signals on the tweet (lean toward skip)

- Post is vague, ragebait, or purely venting with no problem to solve
- Post is already resolved in-thread by another commenter
- Thread has 200+ replies on X or 500+ comments on Reddit — signal
  lost, your reply won't be seen
- Thread is > 2 weeks old (X) or > 30 days old (Reddit) — necro reply
- Author has < 50 followers (X) or < 100 karma (Reddit) — audience too
  small to justify the effort. (X follower count is in the enriched
  author object; Reddit doesn't expose it.)
- Post is in a language you cannot read confidently

---

## Gray zone — default skip, note the ambiguity

When you genuinely cannot tell, **skip with confidence ≤ 0.5** and
explain in `reason` what you'd need to see to flip it. Do NOT queue
speculatively. The reviewer (when active) and the user's own
approve/skip feedback will correct false-skips over time; false-queues
erode trust immediately.

## Confidence calibration

- **≥ 0.85** — obvious signal, you'd bet your turn on this
- **0.6 – 0.85** — clear signal but some missing context (e.g., bio
  not visible, thread thin on detail)
- **0.3 – 0.6** — ambiguous; the verdict could flip on a single
  additional data point
- **≤ 0.3** — you're guessing; prefer to emit nothing rather than
  low-confidence verdicts that poison feedback memory

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

If your system prompt notes that MemoryStore is empty (no prior
approve/skip labels), be **conservative**: prefer to skip borderline
cases. It is cheaper for the product to miss 10 candidates than to
queue 2 bad ones — bad queues train the founder to ignore the Today
page.
