---
name: deep-analysis
description: Deep-dive a thread to assess engagement opportunity and strategy
context: fork
agent: analyst
model: claude-haiku-4-5-20251001
allowed-tools:
  - reddit_get_thread
  - hn_get_thread
  - classify_intent
timeout: 30000
cache-safe: false
---

# Deep Analysis Skill

Analyzes a single high-scoring thread in depth — reads the full comment
tree, classifies intent, and recommends whether and how to engage.

## Workflow

1. Analyst agent fetches the full thread with comments
2. Reads OP and top comments to understand real need
3. Classifies intent with three-layer model (content type, buyer stage,
   poster/reader need)
4. Assesses engagement strategy and risks

## Input

```json
{
  "platform": "reddit",
  "threadId": "1abc2de",
  "subreddit": "SideProject",
  "productName": "ShipFlare",
  "productDescription": "AI marketing autopilot for indie devs",
  "valueProp": "Find and engage with potential users automatically"
}
```

## Output

Engagement decision with confidence, strategy (reply_to_op,
reply_to_comment, skip), risk factors, and structured intent
classification.
