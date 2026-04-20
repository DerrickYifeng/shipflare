---
name: send-email
description: Send a drafted email via the configured provider (Resend). Side-effect skill — no LLM call.
context: inline
model: null
maxTurns: 0
cache-safe: true
output-schema: sendEmailOutputSchema
allowed-tools: []
references:
  - ./references/provider-notes.md
---

# send-email

Sends one email via the configured provider. Unlike the other Phase 5 atoms,
this skill does NOT run an LLM — the dispatcher routes `skillName: 'send-email'`
items directly to `sendEmail()` in `src/skills/send-email/send.ts`. The
SKILL.md lives in the catalog so the planner can schedule it and the
dispatcher has a single routing surface.

## Provider

Default provider is [Resend](https://resend.com/). The implementation reads
`RESEND_API_KEY` from the environment and POSTs to the REST API directly,
so the skill has no NPM dependency to install.

When `RESEND_API_KEY` is absent (local dev, preview environments), the skill
short-circuits with `{ sent: false, reason: 'no_provider' }` — callers MUST
treat that as a non-error state so the planner doesn't stall on missing
infra during onboarding / scripts.

## Input

```ts
{
  to: string;              // recipient email
  from?: string;            // defaults to EMAIL_FROM env var
  replyTo?: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  tag?: string;             // Resend `tags` key for downstream analytics
}
```

## Output

See `sendEmailOutputSchema`. On success: `{ sent: true, providerMessageId, reason: 'sent' }`.
On graceful short-circuit: `{ sent: false, providerMessageId: null, reason: 'no_provider' | 'missing_from_address' }`.
On HTTP failure: `{ sent: false, providerMessageId: null, reason: 'provider_error' }`.

## Why Resend

Resend's REST API is stable, supports idempotency, and returns a message ID
immediately on 200. No SDK needed (`fetch()` is enough). Env keys required:
`RESEND_API_KEY` + `EMAIL_FROM` (must be a verified domain).

Swapping to another provider later is a one-file change inside `send.ts`.
