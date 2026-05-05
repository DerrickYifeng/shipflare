# X/Twitter Review Rules

When the `subreddit` field starts with `@` or the content is clearly for X/Twitter, apply these overrides to the standard review checks.

## Authoritative Platform Check

Call `validate_draft({ text: <draft>, platform: 'x', kind: <post|reply> })` once before the human checks below. Treat its output as the source of truth for:

- **Length** — twitter-text weighted (URLs = 23, emoji = 2, CJK = 2). For threads (multiple tweets joined by `\n\n`), each tweet is measured separately against 280. If `failures` contains a `length` failure, FAIL the review.
- **Sibling-platform leak** — mentions of "reddit", "r/", "subreddit", "upvote", "karma" without an in-sentence contrast marker. FAIL if flagged.
- **Hallucinated stats** — unsourced numeric claims. FAIL if flagged.

## Warnings (informational — flag, don't auto-fail)

- **Hashtag count** — X post: 0-3, X reply: 0. Note in your review notes when out of bounds.
- **Links in body** (post) / **links in reply** — note when present; the founder may want to use `linkReply` instead.
- **Anchor token** (reply only) — note when missing.

## Compliance Check Override
FTC disclosure is NOT required for X. Skip the compliance check for FTC disclosure on this platform.

## Tone Match Override
Verify the tone is:
- Conversational and authentic (not corporate or formal)
- Opinionated with a clear point of view
- Free of marketing buzzwords and superlatives

## Unchanged Checks
Relevance, Value-First, Authenticity, and Risk checks still apply as written in the base agent prompt.
