# Hot-post formats

Common Reddit post formats with concrete markers so the agent emits
specific-enough `topFormats` strings.

## Outcome-first ("X I did to hit Y")

- Opens with the numeric outcome ("$12k MRR", "1200 signups in 4 days").
- Step-by-step or bullet structure.
- Often ends with "happy to answer questions".

Example tag: "outcome-first, numeric headline, bulleted steps"

## Confessional / mistake-first

- Opens with a mistake or failure ("shipped 4 weeks before a customer
  told me the onboarding was broken").
- Short paragraphs, second-person pivots.
- Ends with the lesson learned.

Example tag: "confessional opener, 2-3 short paragraphs, lesson close"

## Teardown

- Breaks down another product / pattern / event.
- Uses headings or numbered sections.
- Includes a verdict at the end.

Example tag: "teardown with headings, explicit verdict close"

## Question-asking ("what are you using for X")

- Opens with the question.
- Often includes the author's own hypothesis so respondents feel
  invited.
- Ends with "I'll follow up with what I chose".

Example tag: "question-asking, author-hypothesis, follow-up promise"

## Show-and-tell ("Show HN / I built X")

- Describes the thing, then invites feedback.
- Screenshots almost always attached.
- Short (< 300 words) to respect readers.

Example tag: "show-and-tell, screenshot-first, <300 words"

## Rant / contrarian

- Starts with a strong opinion against a popular belief.
- Two or three supporting beats.
- Invites pushback.

Example tag: "contrarian rant, 3 supporting beats, explicit invitation for pushback"

## Resource list

- Headline is a number ("7 tools I use for X").
- Each entry has 1-2 sentences.
- Usually includes one twist — a tool the reader wouldn't expect.

Example tag: "resource list, numbered headline, 7-10 entries"

## Writing `topFormats` strings

Good examples:
- `"outcome-first, numeric headline"`
- `"confessional opener, 2-3 short paragraphs"`
- `"show-and-tell with screenshot"`

Bad examples (avoid):
- `"short posts"`
- `"screenshots"`
- `"personal stories"`

Each format string should fit in 60-80 chars and name enough structure
that a drafting agent could imitate it.

## Writing the `insight` field

The insight is ONE observation the planner can act on. It's NOT a
summary of the hot feed. Shape examples:

- "Confessional mistake-first posts outperform tutorials 2:1 in /r/SaaS this
  week. Lead with a specific miss the reader recognizes."
- "The top three posts all include a numeric headline in the first 10
  words. Stack-rank your strongest number in the opener."
- "Small sample (4 visible hot posts); the community is active enough
  for a single weekly post but not two."

Each insight should: (a) name a pattern, (b) give the planner an
actionable implication, (c) acknowledge sample-size limits when they
exist.
