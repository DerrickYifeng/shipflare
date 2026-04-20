# Waitlist landing page checklist

Every page emitted by this skill must satisfy:

## Structural checks

- [ ] Exactly one `<h1>` containing the headline.
- [ ] The subheadline lives in a `<p>` immediately after the `<h1>`.
- [ ] 3-5 value bullets in a `<ul>` — NOT in a `<div>` list.
- [ ] One `<form>` with a labelled `<input type="email">` and a single
      submit button carrying the CTA copy.
- [ ] When `launchTarget.dateISO` is set, include a countdown container
      with a data attribute (`data-launch-at="..."`) so client-side JS can
      hydrate it. The rendered HTML shows a fallback string (e.g.
      "Launching February 14"), not "0d 0h 0m".
- [ ] When `socialProof.quoteLine` is provided, render it inside a
      `<blockquote>` under the form.
- [ ] Footer with `<small>` copyright line using the product name.

## Copy checks

- [ ] Headline: ≤ 80 chars, names outcome not method.
- [ ] Subheadline: 120-240 chars, one clause, names ICP or pain.
- [ ] Each value bullet: ≤ 14 words, outcome-framed.
- [ ] CTA: 2-4 words, imperative, non-generic.
- [ ] No banned phrases anywhere.

## Accessibility checks

- [ ] Form has `aria-label` describing the action.
- [ ] Email input has a visible `<label>` (can be visually hidden via class
      but must exist in markup).
- [ ] Colors (if any are set inline) maintain >= 4.5:1 contrast.
- [ ] `<meta name="viewport" content="width=device-width, initial-scale=1">`
      in the document head wrapper.

## Two worked examples

### Example A — foundation phase, B2B SaaS

Input:
```
product.name: "ShipFlare"
product.valueProp: "Marketing autopilot for indie devs"
audience.primaryICP: "Solo founders shipping weekly"
launchTarget: null
socialProof: null
```

Good headline: "Ship marketing without thinking about marketing."

Sub: "ShipFlare writes the posts, replies, and emails for your launch — in
your voice, not a GPT voice. Built for solo founders who ship weekly."

Bullets:
- Weekly calendar drafted in your voice
- Replies to the right threads, not spam
- Launch-day runsheet, hour by hour
- Everything queued for your approval

CTA: "Join the waitlist"

### Example B — audience phase, launching in 14 days

Input:
```
product.name: "ShipFlare"
launchTarget.dateISO: "2026-05-14T00:00:00Z"
launchTarget.milestoneDescription: "beta closes"
socialProof.accounts: [3 accounts with 5k+ followers each]
```

Good headline: "Your launch shouldn't take two weeks of your time."

Sub: "ShipFlare ships Week 1 content in the 20 minutes it takes you to
approve it. Early-access closes May 14."

Bullets:
- 7 drafted posts a week, in your voice
- Reply-guy engine for the threads that matter
- Launch runsheet built once, executed on the day
- Your approval queue, not a campaign planner

CTA: "Request early access"

Social proof line: the provided quote, rendered verbatim.
