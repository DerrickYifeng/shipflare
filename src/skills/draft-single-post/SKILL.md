---
name: draft-single-post
description: Draft a single original post for one plan_item (one LLM call per item).
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
  - ./references/content-safety.md
---

# draft-single-post

Drafts a single original post for one `plan_item` of kind `content_post`.
One LLM call, one item. Renamed from `slot-body` in Phase 4.

Note: the prompt + references are currently X-idiomatic (character counts,
thread semantics). Reddit support is scoped for Phase 5 — it needs a
`reddit-content-guide.md` reference and an agent-prompt branch on `platform`.
Until then, callers should only invoke this skill with `platform: 'x'`.

## Input

```ts
{
  platform: 'x' | 'reddit';   // which channel the post is for
  contentType: 'metric' | 'educational' | 'engagement' | 'product' | 'thread';
  angle: 'claim' | 'story' | 'contrarian' | 'howto' | 'data' | 'case' | 'synthesis';
  topic: string;
  thesis: string;
  thesisSource: 'milestone' | 'top_reply_ratio' | 'fallback' | 'manual';
  pillar?: string;
  product: { name; description; valueProp; keywords; currentPhase };
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
- Follow `references/content-safety.md` for cross-platform and numeric-claim
  guardrails — drafts that fail those rules are hard-rejected downstream by
  `@/lib/content/validators`.
