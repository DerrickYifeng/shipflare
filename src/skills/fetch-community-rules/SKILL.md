---
name: fetch-community-rules
description: Fetch + summarize a subreddit's rules into a self-promotion policy bucket, key constraints, and a recommendation.
context: fork
agent: fetch-community-rules
model: claude-haiku-4-5-20251001
maxTurns: 2
cache-safe: true
output-schema: communityRulesOutputSchema
allowed-tools:
  - reddit_get_rules
references:
  - ./references/self-promotion-ladder.md
---

# fetch-community-rules

One LLM call per community. Agent uses `reddit_get_rules` to pull the raw
rules, then classifies self-promotion policy (forbidden / restricted /
tolerated / welcomed / unknown) and produces a short list of binding
constraints + a recommendation.

## Input

See agent prompt.

## Output

See `communityRulesOutputSchema`.

## When to run

- Onboarding: fan-out across the user's target communities once.
- Re-run monthly or on demand if community rules change.
- Phase 7 dispatcher uses the `selfPromotionPolicy` field to gate
  whether `draft-single-post` / `draft-single-reply` may mention the
  product in that community.
