# Gate rules — three-gate test + canMentionProduct

A thread must pass ALL THREE gates to earn a reply draft. One miss → skip.
You also decide `canMentionProduct` for the caller (the drafter) to honor.

## Gate 1 — Is this author a potential user?

Pass signals:
- Asking for help with a problem the product solves
- Describing frustration with the status quo the product improves on
- Seeking tool / service recommendations in the product's domain
- Actively stuck on the workflow the product streamlines

Skip signals:
- Competitor promoting their own tool (common on X replies)
- Job seekers / recruiters posting
- Advice-givers teaching others (they don't need the product)
- Meta-commentary ("hot take:" threads, "AI is dead" essays)
- Personal / off-topic posts that happen to use a keyword

## Gate 2 — Can you add something specific?

Every non-skip reply needs at least one anchor (number, brand-like
token, timestamp, or URL). If you can't name one without making it
up, you're writing wallpaper — skip and record "no specific
addition available".

## Gate 3 — Is the reply window still open?

- **X:** ideal 15 min, max 4–6 hours from original post
- **Reddit:** up to ~24 hours, only if comment count < 30

If the window passed → skip.

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
