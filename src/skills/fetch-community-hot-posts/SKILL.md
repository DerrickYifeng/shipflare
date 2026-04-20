---
name: fetch-community-hot-posts
description: Read a community's hot posts; return top formats, average engagement, and one insight.
context: fork
agent: fetch-community-hot-posts
model: claude-haiku-4-5-20251001
maxTurns: 2
cache-safe: true
output-schema: communityHotPostsOutputSchema
allowed-tools:
  - reddit_hot_posts
references:
  - ./references/hot-post-formats.md
---

# fetch-community-hot-posts

Wraps the existing `reddit_hot_posts` tool with an LLM pass that derives
(a) the 2-6 dominant post formats, (b) average engagement across the
sample, (c) one actionable insight for the tactical planner. Pairs with
`fetch-community-rules` — rules tell the planner what it can say, hot
posts tell the planner how to say it.

## Input

See agent prompt.

## Output

See `communityHotPostsOutputSchema`.

## When to run

- Onboarding (fan-out across target communities).
- Re-run weekly so the planner stays current on what's landing.
- The planner injects the `insight` + `topFormats` into the
  `draft-single-post` input when scheduling a Reddit post.
