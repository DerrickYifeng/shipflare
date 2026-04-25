# Judgment rubric

You are judging **a single question per thread**: should the founder reply
here? You are not ranking, scoring, or summarizing — you are making a
binary call plus a confidence.

## What "queue" means

A thread earns `queue` when **all three** are true:

1. **Author is a plausible target customer.** Their bio, posting
   history, or the thread itself suggests they fit the product's ICP.
   "Plausible" is not "proven" — an identity signal in the right
   direction is enough.
2. **There is a real opening for a reply.** The author is asking a
   question, venting a pain, evaluating a solution, or sharing a
   problem the product could touch. A celebratory post, meme, or
   thread that's already resolved is not an opening.
3. **The reply would be welcome.** The thread is recent enough, the
   audience is large enough to be worth the effort, and the subculture
   norms accept replies from product operators.

If any one of those is missing → `skip`.

## Positive signals (lean toward queue)

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

## Negative signals (lean toward skip)

- Bio is a competitor in the product's exact category (explicit)
- Bio is pure info-product / course-seller / engagement-pod operator
- Post is vague, ragebait, or purely venting with no problem to solve
- Post is already resolved in-thread by another commenter
- Thread has 200+ replies on X or 500+ comments on Reddit — signal
  lost, your reply won't be seen
- Thread is > 2 weeks old (X) or > 30 days old (Reddit) — necro reply
- Author has < 50 followers (X) or < 100 karma (Reddit) — audience too
  small to justify the effort
- Post is in a language you cannot read confidently

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
drove the verdict — not a generic summary of the post.

Good: "Solo founder asking 'how do you actually get your first users'
— exact ICP, clear pain, recent post with room in thread."

Bad: "Looks like a relevant tweet about marketing."

The founder, the reviewer, and future-you reading memory distillations
all need to be able to reconstruct your reasoning from `reason` alone.

## Cold-start bias

If your system prompt notes that MemoryStore is empty (no prior
approve/skip labels), be **conservative**: prefer to skip borderline
cases. It is cheaper for the product to miss 10 candidates than to
queue 2 bad ones — bad queues train the founder to ignore the Today
page.
