# Content Safety Guardrails

These rules match the validators in `src/lib/content/validators/`. Drafts
that break them are rejected automatically, so follow them at generation
time instead of forcing a retry.

## 1. Write for the input `platform` only

You receive a `platform` field in your input (e.g. `x` or `reddit`). Do not
name sibling platforms unless the thesis *explicitly contrasts* them.

### When writing for X

- **Do not mention** "reddit", "r/<anything>", "subreddit", "upvote(d/s)",
  or "karma".
- **Contrast is allowed inside a single sentence** when it uses a marker like
  "unlike", "vs", "instead of", "rather than", "compared to", "in contrast
  to", or "as opposed to".
  - OK: `unlike reddit, X rewards quick replies.`
  - OK: `X vs reddit for B2B: X wins on speed.`
  - NOT OK: `we saw this on reddit. cool pattern.` (no contrast)
  - NOT OK: `tools like ours farm karma` (karma without contrast)

### When writing for Reddit

- **Do not mention** "twitter", "x.com", "retweet(ed)", "rt @", "quote
  tweet", or "tweet/tweeted" without contrast.
- Same contrast rules apply.

## 2. No hallucinated statistics

Numeric claims require a real citation in the **same sentence**.

### What counts as a stat

- Percentages: `40%`, `12.5%`
- Multipliers: `10x`, `3.5x`
- "over N" / "up to N" phrases: `over 500 signups`, `up to 300 req/s`
- Currency-shaped numbers with unit suffixes: `$1.2m`, `5k users`

### What counts as a citation (any of)

- `according to <source>`
- `per <Source>` (named source — company, handle, doc)
- `source: <name>`
- An inline URL (`https://...`)
- An `@handle` attribution

### If you do not have a real citation — remove the number

Rewrite the claim as a qualitative statement. Examples:

- ❌ `conversion jumped 40% last month.` (no citation)
- ✅ `conversion jumped last month — the numbers are posted on our changelog page: https://example.com/changelog`
- ✅ `conversion jumped meaningfully last month.` (qualitative rewrite)

## 3. Length caps (per-platform)

- **X post**: 280 code points per tweet (hard cap).
- **X reply**: 240 code points (self-imposed — leaves room for context).
- **Reddit post**: 40,000 code points.
- **Reddit reply**: 10,000 code points.

The validator counts code points, so a single astral emoji (🚀) counts as 1.

## Why these rules exist

The validator pipeline enforces these three rules after every generation and
hard-rejects a draft that fails any of them. Following them up front avoids
retries, protects against platform-wrong copy shipping, and keeps stats
honest.
