# Analytics: signal vs noise

How to pick what goes in `headline`, `highlights`, `lowlights`, and
`recommendedNextMoves` without drowning in noise.

## Signal metrics (name these)

- **Engagement rate** — engagements / impressions. Reliable even across
  small samples because it normalizes for reach.
- **Delta vs prior period** — any number that moved ±25% deserves a
  mention. Particularly: followers delta, engagement rate, top-post
  impressions.
- **Top-post disparity** — when one post carries >50% of weekly
  impressions, say so. It indicates voice drift or lucky algo hit,
  both worth discussing.
- **Posting cadence adherence** — "we planned 7, shipped 4" is useful
  feedback for the planner.

## Noise metrics (skip these unless asked)

- Raw impression count without context. "12,400 impressions" tells the
  reader nothing about trajectory.
- Per-channel breakdowns when only one channel is active.
- Metric deltas < ±10%. Weekly noise, not signal.
- Cumulative totals across all time. Weekly summaries should stay
  weekly.

## Headline construction

Good shapes:
- "Engagement rate fell 28% to 3.1% — the confessional post lost, the
  data post won."
- "Followers grew +42 in a week; first time above the baseline since
  launch week."
- "Seven planned posts, four shipped. The three skipped were all
  Tuesday slots — worth re-thinking the day."

Bad shapes:
- "This week was mixed."
- "We had some wins and some misses."
- "Keep up the great work!"

## Highlights + lowlights

- 2-4 of each. Balanced lists read more honest than "3 highlights, 1
  lowlight".
- Every entry anchored to a number when possible.
- Lowlights should say what happened AND what it suggests, not just
  "impressions were low". Example: "Replies sent dropped 60% Tues-Thu;
  monitor queue was empty — no time-sensitive triggers fired."

## Recommended next moves

Valid shapes (planner can schedule these):
- "Draft 2 contrarian-angle posts for next Tuesday."
- "Shift posting window to 14:00-17:00 UTC — top 3 posts all landed
  there."
- "Skip the weekly drip email for win-back segment; open rate fell to
  8%."
- "Add 1 teardown-format post; the teardown last week outperformed
  outcome posts 1.4x."

Invalid shapes (reject these):
- "Rethink your strategy."
- "Hire a growth lead."
- "Pivot the product."
- "Post more often." (too vague — no cadence named)

Each recommendation should be directly convertible to a `plan_items`
entry by the tactical planner.

## `summaryMd` structure

- Paragraph 1: expand the headline.
- Paragraph 2: what worked this week with one concrete example.
- Paragraph 3: what didn't, why you think it didn't.
- Paragraph 4 (optional): a note about cadence or rhythm.
- Paragraph 5 (optional): what to expect from next week's plan.

Markdown is allowed: **bold**, `code`, bullet lists. Avoid headings
inside the body — the outer surface already frames it.
