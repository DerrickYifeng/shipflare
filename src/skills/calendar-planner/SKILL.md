---
name: calendar-planner
description: Strategic weekly content calendar planning for any channel
context: fork
agent: calendar-planner
model: claude-sonnet-4-6
allowed-tools: []
timeout: 90000
cache-safe: false
shared-references:
  - platforms/x-strategy.md
---

# Calendar Planner Skill

Plans a strategic weekly content calendar based on the user's growth phase,
product context, and past performance data. Channel-specific strategy docs
are auto-injected from `references/` (e.g. `x-strategy.md`).

## Workflow

1. Receive product info, follower count, performance data, and channel
2. Agent reads the matching strategy from injected references
3. Agent determines current growth phase from follower count
4. Agent analyzes past performance to identify winning content patterns
5. Agent generates a 7-day plan with strategically chosen topics and posting times
6. Returns structured calendar entries ready for database insertion

## Input

```json
{
  "channel": "x",
  "productName": "ShipFlare",
  "productDescription": "AI marketing autopilot for indie devs",
  "valueProp": "Ship marketing on autopilot",
  "keywords": ["SaaS", "indie", "marketing"],
  "followerCount": 127,
  "topPerformingContent": [
    {
      "contentType": "metric",
      "impressions": 1200,
      "bookmarks": 15,
      "likes": 45,
      "replies": 8
    }
  ],
  "startDate": "2026-04-14T00:00:00.000Z"
}
```

## Output

Structured plan with phase detection, weekly strategy summary, and calendar entries.
Each entry includes content type, specific topic, strategic goal, and content guidelines.
