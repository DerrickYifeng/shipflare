# X Search Guide

## Platform Routing

Use `x_search` with query strings. `source` is the topic context.

## Filtering (automatic)

`x_search` automatically scopes results to **original tweets only** — replies in someone else's conversation and retweets are excluded before Grok runs. You do not need to add `-is:reply` or `-is:retweet` to your queries. If you explicitly include `is:reply` or `is:retweet`, that opt-in is respected.

## Query Format

Adapt queries for X style — shorter, conversational. X search via Grok understands natural language context.

- Focus on QUESTION-format queries: "how do I", "anyone know", "need help with"
- Target frustration and pain: "struggling with", "can't figure out", "tired of"
- Avoid generic tool/category queries — these attract promoters, not users
- Think about how real people in the product's target audience ask for help on X — adapt to the user's vertical (founders, creators, operators, D2C buyers, specific professions, etc.)

## Filtering Noise

X search returns mostly promotional and advisory content. Apply these filters BEFORE scoring:
- **Competitor self-promo**: Author promoting their own tool → relevance ≤ 0.2, intent = 0.0
- **Tool roundup lists** ("Top 10 tools", "Here are 60 tools"): Curator, not user → relevance ≤ 0.2
- **Teaching/coaching threads** ("Here's how to...", "My framework..."): Giving advice, not seeking → intent ≤ 0.2
- **Success stories** ("How I got X users", "Here's what worked"): Sharing, not seeking → intent ≤ 0.2
- **Generic news/opinion** without personal pain: Not a potential user → relevance ≤ 0.1

Only score HIGH for tweets where the author is:
- **Asking a question** ("how do I...?", "anyone know...?")
- **Describing their OWN struggle** ("I can't figure out...", "been trying to...")
- **Requesting recommendations** ("what tools do you use for...?")

## Field Mapping

When collecting X results, map fields to the standard format:
- `tweetId` → `id`
- `text` → `title`
- `text` → `body` (pass through the full tweet text)
- `author` → `author`
- `url` → `url`
- **`community`**: pass the input `source` string verbatim (e.g. `SaaS`,
  `startup tools`). **Do NOT add any `"X - "` or `"X / "` prefix — the UI
  renders the `𝕏 ·` mark.** All tweets from a single discovery run share
  the same `community` value because X has no per-tweet community concept;
  the search topic is the grouping key.
- Do not invent a per-tweet category from the tweet content. Two tweets
  about "growth strategy" surfaced by a `SaaS` search both have
  `community: "SaaS"`.

**Timestamp note:** `x_search` does not return tweet creation dates. Omit
`postedAt` entirely for X results — do NOT fabricate a date. The Today
card falls back to `discoveredAt`.
