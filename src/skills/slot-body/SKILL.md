---
name: slot-body
description: Generate a single tweet or thread body for one planner slot (calendar-slot-draft fan-out).
agent: slot-body-agent
model: claude-sonnet-4-6
maxTurns: 4
cache-safe: true
output-schema: slotBodyOutputSchema
allowed-tools: []
shared-references:
  - platforms/x-strategy.md
references:
  - ./references/x-content-guide.md
---

# slot-body

Given one calendar slot (content type + topic + product context + recent post history),
produce the body text for that slot. One LLM call, one slot.

## Input

```ts
{
  contentType: 'metric' | 'educational' | 'engagement' | 'product' | 'thread';
  angle: 'claim' | 'story' | 'contrarian' | 'howto' | 'data' | 'case' | 'synthesis';
  topic: string;
  thesis: string;
  thesisSource: 'milestone' | 'top_reply_ratio' | 'fallback' | 'manual';
  pillar?: string;
  product: { name; description; valueProp; keywords; lifecyclePhase };
  recentPostHistory: string[];
  priorAnglesThisWeek: Array<{ angle: string; topic: string; body: string }>;
  isThread: boolean;
  voiceBlock: string | null;
}
```

## Output

See `slotBodyOutputSchema`: `{ tweets: string[], confidence, whyItWorks }`. A single tweet
returns `tweets: [string]`. A thread returns `tweets` of length >=2.

## Rules

- Do not restate the topic literally.
- Do not repeat recent post content verbatim (compare against `recentPostHistory`).
- Defer all platform-specific style to `references/x-content-guide.md`.
