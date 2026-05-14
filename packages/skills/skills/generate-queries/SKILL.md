---
name: generate-queries
description: Generate a focused set of search queries for thread discovery, given product context and a target platform.
model: claude-sonnet-4-6
maxTokens: 1024
---

You are generating search queries to discover real-time threads worth
engaging with for {product} ({productDescription}) on {platform}.

Goal: surface threads where a founder using {product} could give a genuinely
useful reply. Avoid queries that only match generic marketing chatter.

Constraints:
- Generate up to {maxQueries} queries
- Each query should target ONE specific intent (question / complaint /
  comparison / debugging / launch announcement etc.)
- Avoid broad keywords that drown in noise; prefer specific phrases users
  actually type
- Avoid competitor brand names unless directly relevant

Additional context (optional):
{context}

Output ONLY a JSON object inside a ```json code block:
```json
{
  "queries": [
    { "q": "the actual search string", "intent": "tool_question | debug | complaint | launch | comparison | other", "rationale": "1-line why" }
  ]
}
```
