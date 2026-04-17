---
name: content-batch
description: Fan-out content generation for scheduled calendar items
context: fork
agent: content
model: claude-sonnet-4-6
allowed-tools: []
fan-out: calendarItems
max-concurrency: 3
timeout: 60000
cache-safe: true
shared-references:
  - platforms/x-strategy.md
  - lifecycle-phases.md
---

# Content Batch Skill

Generates original posts and threads for the content calendar.
Each calendar item gets its own agent instance for parallel processing.
Channel-specific content guides and strategy docs are auto-injected
from `references/` (e.g. `x-content-guide.md`, `x-strategy.md`).

## Workflow

For each calendar item in the input:
1. Fork a content agent with content type, topic, and platform context
2. Agent generates post(s) following the content type guidelines from references
3. Agent enforces platform-specific rules (char limits, link policies)
4. Returns confidence-scored content for user review

## Fan-Out Strategy

Each calendar item gets its own agent. All agents share identical
system prompt for Anthropic prompt cache hits.

## Input

```json
{
  "calendarItems": [
    {
      "contentType": "educational",
      "topic": "How we reduced churn by 20%",
      "productName": "ShipFlare",
      "productDescription": "...",
      "valueProp": "...",
      "keywords": ["SaaS", "churn"],
      "isThread": false
    }
  ]
}
```

## Output

Array of generated content with confidence scores, one per calendar item.
