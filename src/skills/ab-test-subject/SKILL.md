---
name: ab-test-subject
description: Generate two subject-line variants (A/B) for one email body.
context: fork
agent: ab-test-subject
model: claude-haiku-4-5-20251001
maxTurns: 1
cache-safe: true
output-schema: abTestSubjectOutputSchema
allowed-tools: []
references:
  - ./references/subject-axes.md
---

# ab-test-subject

Given one drafted email + its current subject, emit two subject variants
that differ on a deliberate axis (opener, specificity, length, framing).
Used between `draft-email` and `send-email` when the plan item's
`userAction` is `approve` (human-in-the-loop split) or when the caller
opts into auto-split testing.

## Input

See agent prompt. `voiceBlock` gates emoji usage.

## Output

See `abTestSubjectOutputSchema`: `{ variantA: { subject, rationale }, variantB: { subject, rationale } }`.

## When to run

- Before the first `welcome` / `drip` send, to learn the cohort's opener
  preference.
- Before `retro_launch` where the headline number deserves a large audience.
- Skip for `thank_you` / transactional — no meaningful A/B signal.

The Phase 7 dispatcher checks the current plan_item's `emailType` and skips
this skill when not useful.
