---
name: calendar-planner
description: Strategic weekly content calendar planning (thesis + angles) for any channel
context: fork
agent: calendar-planner
model: claude-sonnet-4-6
allowed-tools: []
timeout: 90000
cache-safe: false
shared-references:
  - platforms/x-strategy.md
references:
  - ./references/x-angle-playbook.md
  - ./references/milestone-to-angles.md
  - ./references/fallback-modes.md
---

# Calendar Planner Skill

Produces a weekly content calendar organised around one **thesis** (the claim
the week argues for) and seven **angles** (claim / story / contrarian / howto
/ data / case / synthesis) distributed across days.

Derivation priority: `milestone` > `top_reply_ratio` > `fallback` > `manual`.
When no milestone or hot tweet is available, the planner picks a fallback mode
from `fallback-modes.md`.

1–2 day offsets per week are reserved as `whiteSpaceDayOffsets` for reactive
posts — the slot-body fan-out skips those.

## Input

```json
{
  "channel": "x",
  "productName": "…",
  "productDescription": "…",
  "valueProp": "…",
  "keywords": ["…"],
  "lifecyclePhase": "launched",
  "followerCount": 127,
  "startDate": "2026-04-14T00:00:00.000Z",
  "postingHours": [14, 17, 21],
  "milestoneContext": "shipped $19/mo tier",
  "topPerformingContent": [],
  "analyticsInsights": null
}
```

## Output

See `calendarPlanOutputSchema` — thesis + thesisSource + whiteSpaceDayOffsets
+ entries with per-slot angles.
