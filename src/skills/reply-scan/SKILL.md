---
name: reply-scan
description: Fan-out reply drafting across monitored posts from target accounts
context: fork
agent: reply-drafter
model: claude-sonnet-4-6
allowed-tools:
  - x_get_tweet
  - x_search
fan-out: tweets
max-concurrency: 3
timeout: 60000
cache-safe: true
---

# Reply Scan Skill

Drafts high-value replies to posts from monitored target accounts.
Each monitored post gets its own agent instance for parallel processing.

## Workflow

For each post in the input:
1. Fork a reply-drafter agent with the post context
2. Agent reads the post, selects a reply strategy
3. Agent drafts a reply (respecting platform limits, no links, genuine value)
4. Returns confidence-scored reply for user review

## Fan-Out Strategy

Each post gets its own agent. All agents share identical system prompt
and tools for Anthropic prompt cache hits (~90% cost reduction on
agents 2-N).

## Input

```json
{
  "tweets": [
    {
      "tweetId": "123",
      "tweetText": "...",
      "authorUsername": "levelsio",
      "platform": "x",
      "productName": "ShipFlare",
      "productDescription": "...",
      "valueProp": "...",
      "keywords": ["indie hacker", "SaaS"],
      "canMentionProduct": false
    }
  ]
}
```

## Output

Array of reply drafts with confidence scores, one per input post.
