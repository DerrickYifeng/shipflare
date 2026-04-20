# Email provider notes

## Resend (default)

- Base URL: `https://api.resend.com`
- Endpoint: `POST /emails`
- Auth: `Authorization: Bearer $RESEND_API_KEY`
- Body shape (JSON):
  ```
  {
    "from": "Yifeng <noreply@yourdomain.com>",
    "to": ["user@example.com"],
    "subject": "...",
    "text": "...",
    "html": "...",
    "reply_to": "founder@yourdomain.com",
    "tags": [{ "name": "kind", "value": "welcome" }]
  }
  ```
- Success: `200 { id: "uuid" }`.
- Failure: `>=400 { message, ... }` — surface as `provider_error`.

## Required env vars

- `RESEND_API_KEY` — API key from Resend dashboard. Absent → skill short-
  circuits to `{ sent: false, reason: 'no_provider' }`.
- `EMAIL_FROM` — verified sender domain + display name
  (e.g. `ShipFlare <noreply@shipflare.dev>`). Absent → skill returns
  `{ sent: false, reason: 'missing_from_address' }`.

## Idempotency

Not auto-added. If the dispatcher re-drives a `plan_items` row through the
send step (e.g., retry after a transient 500), include an `Idempotency-Key`
header derived from `plan_items.id`. That wiring is Phase 7 work —
`send.ts` already accepts an optional `idempotencyKey` parameter.

## Local dev

Run without the env var; the skill no-ops. For integration testing, set
`RESEND_API_KEY=re_testing_...` and use a verified Resend sandbox domain.

## Swapping providers

To move to Postmark / SES / anything else, edit `send.ts` only. The SKILL.md
contract and `sendEmailOutputSchema` do not reference Resend anywhere — the
skill's external interface is provider-agnostic by design.
