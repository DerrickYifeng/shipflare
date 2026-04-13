---
name: community-intel
description: Read community rules and hot topics to inform content strategy
context: fork
agent: scout
model: claude-haiku-4-5-20251001
allowed-tools:
  - reddit_get_rules
  - reddit_hot_posts
fan-out: subreddits
max-concurrency: 5
timeout: 60000
cache-safe: true
---

# Community Intelligence Skill

Reads a subreddit's rules and hot posts to understand culture,
self-promotion policies, and what content formats perform well.
Used before content generation to tailor drafts.

## Workflow

For each subreddit in the input:
1. Fetch community rules via `reddit_get_rules`
2. Fetch hot posts via `reddit_hot_posts`
3. Analyze rules for self-promotion policies
4. Identify trending topics and successful post formats
5. Recommend whether to reply to existing threads, create original posts, or both

## Input

```json
{
  "product": {
    "name": "ShipFlare",
    "description": "AI marketing autopilot for indie devs",
    "keywords": ["marketing", "reddit"],
    "valueProp": "Find and engage with potential users automatically"
  },
  "subreddits": ["SideProject", "startups", "webdev"]
}
```

## Output

Per-subreddit intelligence report with rules summary, hot topics,
and recommended engagement approach.
