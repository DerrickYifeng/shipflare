# Milestone → 7-angle decomposition templates

When the user has a concrete product event this week, derive the thesis and
angle topics from it. Four canonical milestones:

## A. Shipped feature

**Thesis form:** "we shipped X because Y problem was costing users Z" — the
feature is the *answer*, the problem is the *topic*.

- `claim` — the user problem in one line, plus the thesis ("we shipped X to solve it")
- `story` — the one customer conversation that triggered the decision
- `contrarian` — what competing products do instead, and why it's wrong for this user segment
- `howto` — demo walkthrough (screen recording or gif described in the topic)
- `data` — adoption or activation number 48h after ship
- `case` — one user who used it immediately and what changed for them
- `synthesis` — what we cut to ship X, and the next problem on the stack

## B. Metric hit (revenue, user count, year anniversary)

**Thesis form:** "getting to X was not what I expected — here's the actual
mechanism" — NOT "celebration of the number itself".

- `claim` — the counter-intuitive mechanism behind the number
- `story` — the specific week/decision that made the curve bend
- `contrarian` — the thing everyone said would matter that didn't
- `howto` — the 3-step repeatable version of what worked
- `data` — the full time series (not just today's number)
- `case` — one user whose behavior changed as the number crossed the threshold
- `synthesis` — what this unlocks + honest list of what still isn't working

Avoid naked MRR-screenshot flex as Day 1. Research: "time-to-revenue plausibility"
has replaced "revenue number" as the credibility signal (TrustMRR / Levels
public-skepticism thread). Lead with the *mechanism*, show the number as `data`.

## C. Customer story (case study, testimonial, unexpected user behavior)

**Thesis form:** "one user discovered a job-to-be-done we hadn't designed for,
here's what it teaches."

- `claim` — the job-to-be-done, named
- `story` — the customer's actual trigger event (Bourgoin trigger technique)
- `contrarian` — the way the product was *supposed* to be used vs this
- `howto` — how to reproduce this pattern for other users
- `data` — how many other users share this job-to-be-done (rough %)
- `case` — second customer exhibiting the same pattern, validating it isn't a one-off
- `synthesis` — the product decision this is pushing — ship, kill, or leave alone

## D. Failure / post-mortem (this is a build-in-public superpower, do not skip it)

**Thesis form:** "we broke X because we underestimated Y — here's the
timeline and the fix."

- `claim` — what broke, in one sentence, no hedging
- `story` — first 30 minutes of the incident
- `contrarian` — the assumption we made that turned out wrong
- `howto` — the 3 things we changed to make this unrepeatable
- `data` — blast radius (downtime, affected users, revenue lost)
- `case` — a customer who noticed and how we talked to them
- `synthesis` — what we'd do differently + what stays broken on purpose

Self-skepticism register is a 2026 credibility move — do not "reframe failure as
growth" with motivational language. Lead with the blunt admission.

---

## Instructions to the planner

Given the user's input, look for a milestone signal in this priority order:

1. `product.lifecyclePhase === 'launched'` with a `recent_ship` entry in memory — template A
2. A `xTweetMetrics` tweet from the last 14 days whose `replies/impressions > 15%` — promote to thesis, template C or D depending on the tweet's register
3. An explicit `milestoneContext` in the input — use as-is
4. No milestone → switch to fallback mode (`fallback-modes.md`)
