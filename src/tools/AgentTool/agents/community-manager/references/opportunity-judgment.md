# Opportunity judgment — when may the reply mention the product?

You decide a single question per thread, INLINE in the same LLM
turn that drafts the reply: **may this reply organically mention
{productName}, or must the mention be suppressed?**

There is no separate `product-opportunity-judge` tool to call —
you apply these rules in your own reasoning before you write the
draft body. Note your verdict + signal name in your draft notes
so the founder can audit later.

## The two outputs you decide

- `canMentionProduct: true | false` — the boolean that gates
  whether the reply body may name {productName}, link to it,
  recommend it, or otherwise pitch.
- `signal` — exactly one of the enum values below. Used in the
  sweep's `skippedRationale` summary so the founder can see the
  shape of opportunity calls across the sweep.
- `confidence` — 0.0–1.0 internal to your reasoning. Below 0.6 on
  a green-light → treat as hard-mute (suppress the mention) anyway.

## Green-light signals → `canMentionProduct: true`

The OP must have invited the mention. Choose the strongest signal:

- **`tool_question`** — OP literally asks "what do you use for X?"
  / "recommend a tool for Y" / "best stack for Z" AND the product
  plausibly fits the ask. The tweet must be a question, not an
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
need AND your confidence is ≥ 0.6 → set `canMentionProduct: true`
and your reply MAY (but doesn't have to) name the product. Even
under green-light, only mention the product when the natural
phrasing of the answer needs it — never bolt the pitch onto an
unrelated reply.

## Hard-mute signals → `canMentionProduct: false`

If any of these fire, suppress the mention regardless of any
green-light:

- **`milestone_celebration`** — revenue, user count, years,
  anniversaries. Pitching into a celebration reads predatory.
- **`vulnerable_post`** — burnout, doubt, grief, "close to
  giving up", "first churn hurt more than I expected".
- **`grief_or_layoff`** — job loss, company death, personal
  hardship.
- **`political`** — political takes, culture war, social-issue
  posts.
- **`no_fit`** — no green-light or hard-mute signal fires; the
  OP isn't asking for a tool and isn't in a sensitive
  emotional register. Default to suppression.

## Strictness — when in doubt, suppress

- False-negatives (missed plug opportunity) are cheap — the
  founder still got an on-brand reply, they just didn't get an
  inline mention.
- False-positives (pitching into a vulnerable post, into a
  political thread, or into someone celebrating) cost reputation
  in a way that's hard to undo.

If you can't pick a green-light signal with confidence ≥ 0.6,
default `canMentionProduct: false` and write the reply WITHOUT
naming the product. The reply still ships; it just stays generic
on the product front.

## Examples

### Green-light: tool_question

> "anyone got a good way to keep my X drafts organized? tried
> notion, airtable, hated both."

Signal: `tool_question`. Confidence: 0.85. The OP is literally
asking for a tool recommendation in {productName}'s domain. May
mention {productName} naturally in the answer.

### Green-light: debug_problem_fit (product fits)

> "spent 6 hrs trying to figure out why my drafts keep losing
> their voice when the agent regenerates them"

Signal: `debug_problem_fit`. Confidence: 0.75. OP is debugging
a specific symptom {productName}'s voice-injection feature
addresses. May mention naturally — anchor on the specific fix,
not a marketing pitch.

### Hard-mute: vulnerable_post

> "first churn hit today and I'm gutted"

Signal: `vulnerable_post`. Confidence: 0.95. The reply still
gets drafted (this is exactly the kind of thread where a
human reply matters), but `canMentionProduct: false`. The
draft body should be a `supportive_peer` archetype with no
product reference at all.

### Hard-mute: milestone_celebration

> "we just crossed $10k MRR — 14 months of grinding"

Signal: `milestone_celebration`. Even though the founder is in
the same space, pitching here reads as opportunistic.
`canMentionProduct: false`. Draft a `supportive_peer` or
`question_extender` reply.

### No-fit (default suppression)

> "spring is officially here in nyc 🌸"

Signal: `no_fit`. Confidence: 0.95. Skip the entire thread (it
fails Gate 1 in `reply-quality-bar` anyway — the author isn't a
potential user in this moment).

### Borderline: weak green-light → suppress

> "thinking about switching off twitter completely. anyone tried
> reddit instead?"

Signal: could be `tool_question` (asking for a platform
recommendation), but the platform-vs-platform framing is a
political-ish "leaving X" sentiment. Confidence: 0.4.
`canMentionProduct: false` — the natural reply is about
platform mechanics, not pitching {productName}.

## Output recording

You don't return a structured judge result; you record the verdict
inline in the draft's `whyItWorks` field and (in summary) in the
sweep's `skippedRationale`. Example `whyItWorks` line that captures
the judgment + the archetype reasoning:

> "supportive_peer reply on a milestone celebration. Did NOT
> mention {productName} (signal: milestone_celebration, conf 0.9
> — pitching reads predatory)."

Sweep-level rollup in `notes`:

> "Of 12 threads scanned, 4 cleared all three gates. Opportunity
> calls: 1 tool_question (mention allowed), 2
> milestone_celebration (mention suppressed), 1 no_fit (drafted
> without mention)."
