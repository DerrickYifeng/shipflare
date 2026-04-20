---
name: draft-hunter-outreach
description: Draft one personalized DM to one Product Hunt hunter.
context: fork
agent: draft-hunter-outreach
model: claude-sonnet-4-6
maxTurns: 1
cache-safe: true
output-schema: draftHunterOutreachOutputSchema
allowed-tools: []
references:
  - ./references/hunter-dm-patterns.md
---

# draft-hunter-outreach

One hunter, one DM. Planner schedules this during the `momentum` phase for
each target hunter the user approved. Returns the DM text + the
personalization hook the agent chose (for downstream dedupe when re-running
against the same hunter) + a confidence score.

## Input

See agent prompt. When the profile has no `recentHunts` / `recentComments`
/ `recentTweets`, the skill deliberately emits a short DM with
`confidence < 0.4` rather than fabricating personalization — the user
should decide whether to send or skip.

## Output

See `draftHunterOutreachOutputSchema`.

## When to run

- `launch_asset` or `content_reply` plan_items targeting PH hunters.
- Scheduled in the `momentum` phase (T-7 to T-0 days).
- Dedupe upstream on `(hunterUsername, personalizationHook)` — don't reuse
  the same hook twice with the same hunter.
