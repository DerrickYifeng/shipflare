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
1. **Pre-pass:** run `product-opportunity-judge` — emits `canMentionProduct`
2. **Draft:** fork a reply-drafter agent with post context + `canMentionProduct`
3. **Post-validate:** run `validateAiSlop` + `validateAnchorToken` over `replyText`
   - If either fails, downgrade `strategy` to `skip` and persist `rejectionReasons`
4. Return confidence-scored reply (or skip) for user review

Composition happens in `src/workers/processors/reply-hardening.ts` via `draftReplyWithHardening()`.

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
      "canMentionProduct": false,
      "voiceBlock": null
    }
  ]
}
```

## Output

Array of reply drafts with confidence scores, one per input post.
