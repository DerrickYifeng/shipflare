---
name: community-discovery
description: Discover communities where target users congregate
context: fork
model: claude-haiku-4-5-20251001
allowed-tools:
  - reddit_discover_subs
timeout: 60000
cache-safe: false
---

# Community Discovery Skill

Finds online communities where a product's target users actively discuss
relevant problems. Searches across Reddit, HackerNews, and long-tail
platforms via web search.

## Workflow

1. Scout agent generates search terms from product context
2. Searches Reddit for relevant subreddits (subscriber count, activity)
3. Searches HN for relevant discussions (points, comment density)
4. Uses web search with site filters for long-tail communities
5. Classifies sample posts from top candidates to gauge audience fit

## Input

```json
{
  "product": {
    "name": "ShipFlare",
    "description": "AI marketing autopilot for indie devs",
    "keywords": ["marketing", "reddit", "side project"],
    "valueProp": "Find and engage with potential users automatically"
  }
}
```

## Output

Sorted list of communities by audience fit score, with platform,
subscriber/activity metrics, and reasoning for each recommendation.
