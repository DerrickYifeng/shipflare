---
name: classify-thread-sentiment
description: One thread → one sentiment label (pos / neg / neutral / mixed) + confidence + rationale.
context: fork
agent: classify-thread-sentiment
model: claude-haiku-4-5-20251001
maxTurns: 1
cache-safe: true
output-schema: threadSentimentOutputSchema
allowed-tools: []
references:
  - ./references/label-examples.md
---

# classify-thread-sentiment

Lightweight classifier — one LLM call per thread. Feeds the tactical
planner's reply-angle selection (skip contrarian replies on `neg`
threads, lean into gratitude patterns on `pos` ones).

## Input

See agent prompt.

## Output

See `threadSentimentOutputSchema`.

## When to run

- Inline during the discovery pipeline (search-source → classify →
  draft-single-reply).
- The Phase 7 dispatcher decides whether to route the output to a
  plan_items row; for v1 this is typically inline.
