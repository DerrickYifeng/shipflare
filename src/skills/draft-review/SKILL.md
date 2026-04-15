---
name: draft-review
description: Adversarial quality review of generated reply drafts
context: fork
agent: draft-review
model: claude-haiku-4-5-20251001
allowed-tools: []
fan-out: drafts
max-concurrency: 5
timeout: 45000
cache-safe: true
---

# Draft Review Skill

Adversarial quality review of content-gen output. Each draft is
independently reviewed against six checks: relevance, value-first,
tone match, authenticity, FTC compliance, and risk assessment.

## Workflow

For each draft in the input:
1. Review agent reads the draft alongside original thread context
2. Runs all 6 mandatory checks
3. Assigns verdict: PASS, REVISE, or FAIL
4. Provides specific issues and actionable suggestions

## Fan-Out Strategy

Each draft gets its own reviewer instance. All reviewers share
identical system prompt for prompt cache hits.

## Input

```json
{
  "drafts": [
    {
      "replyBody": "The draft reply...",
      "threadTitle": "Best tools for...",
      "threadBody": "Looking for...",
      "subreddit": "SideProject",
      "productName": "ShipFlare",
      "productDescription": "AI marketing autopilot for indie devs",
      "confidence": 0.85,
      "whyItWorks": "Rationale from content agent..."
    }
  ]
}
```

## Output

Array of review verdicts with per-check results, issues, and suggestions.
