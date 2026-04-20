---
name: draft-waitlist-page
description: Draft HTML + addressable copy for a single waitlist landing page.
context: fork
agent: draft-waitlist-page
model: claude-sonnet-4-6
maxTurns: 1
cache-safe: true
output-schema: draftWaitlistPageOutputSchema
allowed-tools: []
references:
  - ./references/landing-page-checklist.md
---

# draft-waitlist-page

Produces one waitlist landing page per invocation. Output includes both the
assembled HTML and the copy broken into `{ headline, subheadline, cta,
valueBullets, socialProofLine }` so the caller can re-render inside a CMS /
MDX template without round-tripping through HTML parsing.

Typical use: the tactical planner schedules this during the foundation or
audience phase for any product without a live waitlist. A single
invocation; the user iterates via edits on the returned copy.

## Input

See agent prompt.

## Output

See `draftWaitlistPageOutputSchema`.

## Design stance

The page is deliberately minimal — one headline, one sub-headline, 3-5
value bullets, one CTA, optional social proof. Generic marketing fluff is
banned at the prompt layer. Phase 11's shared onboarding primitives do not
apply here — this is a standalone marketing surface the user will host on
their own domain.
