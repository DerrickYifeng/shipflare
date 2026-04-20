# Sentiment label examples

One worked example per label + common confusions.

## pos

Title: "Hit $1k MRR in month 2 — here's the breakdown"

Body: explains the numbers, thanks the community.

Top comments: celebrations, follow-up questions about the approach.

Rationale template:
> "OP celebrates a concrete milestone; top comments are congratulatory
> with follow-up questions."

Confidence: typically 0.85+.

## neg

Title: "Spent 3 months on a feature nobody wanted"

Body: founder vents about misreading the market.

Top comments: sympathy, "been there", constructive questions.

Rationale template:
> "OP expresses frustration about wasted effort; top comments are
> sympathetic acknowledgement."

Confidence: 0.8-0.9 (the OP drives this — even supportive replies
don't flip the label).

## neutral

Title: "Which Postgres hosting do you use for side projects?"

Body: asks the question without a strong stance.

Top comments: factual recommendations.

Rationale template:
> "OP asks an informational question without emotional loading; top
> comments provide factual answers."

Confidence: 0.7-0.85.

## mixed

Title: "Launched! Thoughts?"

Body: positive, excited.

Top comments: split — some positive, two surface a structural concern
("charts look misleading", "pricing tier confusion").

Rationale template:
> "OP is excited but top comments surface substantive criticism; the
> thread's overall emotional tone is split."

Confidence: 0.6-0.8 depending on how balanced the split is.

## Common confusions

### Technical frustration ≠ neg

A thread titled "Why is my Redis connection timing out" with a
frustrated body is typically `neutral` — it's a debugging request, not
a venting post. `neg` requires emotional loading beyond "I'm stuck".

### Supportive replies don't flip a neg OP

A `neg` OP with warm supportive comments stays `neg`. The thread's
tone was set by the OP. Use `mixed` only when top comments
*substantively push back*, not when they comfort.

### Gratitude ≠ pos for the product

A thread thanking a competitor or thanking the community (not the
product) is still a valid `pos` thread. The classifier reports the
thread's tone, not its commercial value.

### Rant with an invitation

"Rant: agencies overcharge for X, what are you using instead?" is
typically `mixed` — the OP is venting (`neg` signal) but asking a
constructive question (`neutral` signal). Call it `mixed` with 0.6
confidence.
