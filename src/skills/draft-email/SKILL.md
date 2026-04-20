---
name: draft-email
description: Draft a single lifecycle / transactional email. Branch by emailType.
context: fork
agent: draft-email
model: claude-sonnet-4-6
maxTurns: 1
cache-safe: true
output-schema: draftEmailOutputSchema
allowed-tools: []
references:
  - ./references/email-playbook.md
---

# draft-email

Generates subject + body for one email per invocation. The caller supplies
`emailType` + a recipient context + a voice block; the agent returns a single
email object. Pairs with `send-email` (the actual delivery) and
`ab-test-subject` (run before sending to get two subject variants).

Email types handled by the prompt:

- `welcome` — signup confirmation
- `thank_you` — specific post-action note (PH upvote, beta access accepted, etc.)
- `retro_week_1` / `retro_launch` — long-form retro
- `drip_week_1` / `drip_week_2` / `drip_retention` — educational cadence
- `win_back` — dormant-user re-engagement

## Input

See agent prompt. `product.currentPhase` comes from `derivePhase()` and is
injected so tone shifts across foundation/launch/steady.

## Output

See `draftEmailOutputSchema`: `{ subject, bodyText, bodyHtml?, previewText? }`.

## Rules of thumb

- One insight per email, not a feature dump.
- Never say "we hope this email finds you well" or any AI-canonical preamble.
- Subject < 55 chars, specific over clever.
- Plain-text body is required; HTML is optional and only emitted if the
  caller's downstream pipeline supports HTML delivery.
