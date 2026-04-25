---
name: product-opportunity-judge
description: Pre-pass classifier deciding whether a reply may mention the user's product
context: fork
agent: product-opportunity-judge
model: claude-haiku-4-5
allowed-tools: []
fan-out: tweets
max-concurrency: 3
timeout: 20000
cache-safe: true
output-schema: productOpportunityJudgeOutputSchema
---

# Product Opportunity Judge Skill

Runs **before** `x-reply-writer` on every in-scope tweet. Emits a boolean
`allowMention` flag consumed by the drafter. Policy for which signals count
as green-light vs hard-mute lives in
`src/tools/AgentTool/agents/product-opportunity-judge/AGENT.md`.

## Input

```json
{
  "tweets": [
    {
      "tweetId": "...",
      "tweetText": "...",
      "authorUsername": "...",
      "quotedText": "...",
      "product": { "name": "...", "description": "...", "valueProp": "...", "keywords": ["..."] }
    }
  ]
}
```

## Output

Array of `ProductOpportunityJudgeOutput`, one per input tweet, same order.
