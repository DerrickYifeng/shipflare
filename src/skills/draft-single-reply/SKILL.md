---
name: draft-single-reply
description: Draft a single reply to a monitored post or discovered thread (one LLM call per item).
context: fork
agent: x-reply-writer
model: claude-sonnet-4-6
allowed-tools:
  - x_get_tweet
  - x_search
fan-out: tweets
max-concurrency: 3
timeout: 60000
cache-safe: true
---

# draft-single-reply

Drafts a single reply to one monitored post or discovered thread. Pairs
with `draft-single-post` — both are the atomic executors the tactical
planner targets when it emits `plan_items` of kind `content_reply` /
`content_post`. Renamed from `reply-scan` in Phase 4.

Each monitored post gets its own agent instance for parallel processing;
the fan-out key stays `tweets` for now because the monitor processor is
the only caller. The key will generalize with the Reddit / discovery path
when the Phase 7 plan-execute dispatcher lands.

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
