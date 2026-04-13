---
name: content-gen
description: Generate contextual replies for discovered threads
context: fork
agent: content
model: claude-sonnet-4-6
allowed-tools: []
fan-out: threads
max-concurrency: 3
timeout: 30000
cache-safe: true
---

# Content Generation Skill

Generates contextual, value-first replies for threads where engagement
has been approved. Each reply leads with genuine help and mentions the
product naturally.

## Workflow

For each thread in the input:
1. Content agent reads thread context (title, body, subreddit)
2. Drafts a reply that provides genuine value first
3. Naturally mentions the product where relevant
4. Includes FTC disclosure at the end
5. Self-assesses confidence and explains strategy

## Fan-Out Strategy

Each thread gets its own agent instance. All agents share identical
system prompt for Anthropic prompt cache hits.

## Input

```json
{
  "threads": [
    {
      "threadTitle": "Best tools for automating social media?",
      "threadBody": "Looking for something to help with Reddit marketing...",
      "subreddit": "SideProject",
      "productName": "ShipFlare",
      "productDescription": "AI marketing autopilot for indie devs",
      "valueProp": "Find and engage with potential users automatically",
      "keywords": ["marketing", "reddit", "automation"]
    }
  ]
}
```

## Output

Array of drafted replies with confidence scores and strategy rationale.
