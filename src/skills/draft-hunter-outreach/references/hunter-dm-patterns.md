# Hunter DM patterns

Three worked examples at descending personalization levels. The agent
should calibrate `confidence` against which level it's operating at.

## Level 1 — strong personalization (confidence 0.75-0.95)

Hunter data includes a recent hunt + recent comment OR tweet that overlaps
with the product's wedge. Example DM:

> Saw you hunted RepoSpy last Tuesday — your comment on the analytics
> angle stuck with me. We're shipping ShipFlare on May 14; it's the piece
> RepoSpy doesn't do: the posting / reply / email side of what a solo dev
> has to do every week.
>
> Would you hunt it? I can have gallery + tagline over to you by Thursday.
>
> Totally no worries if it's not your lane — picked you because the
> analytics-to-action gap is the exact thing we're trying to close.
>
> — Yifeng

Personalization hook: "your comment on the analytics angle on RepoSpy"

Why this works: specific product + specific line from the hunter +
substantive framing that shows the founder has read their taste, not just
their follower count.

## Level 2 — light personalization (confidence 0.5-0.75)

Hunter data is thinner — you can see their recent hunts but no comments
or tweets worth quoting. Example DM:

> Noticed you've been hunting a lot of developer tools lately (SwiftLogs
> and Bench on the same week caught my eye). We're shipping ShipFlare on
> May 14 — marketing autopilot for indie devs, so probably your kind of
> category.
>
> Want to hunt it? Assets ready Thursday.
>
> — Yifeng

Personalization hook: "developer tools hunting pattern (SwiftLogs, Bench)"

Why this works: still specific (names two real hunts) without pretending
to know their deeper taste.

## Level 3 — no personalization (confidence < 0.4)

No recent hunts / comments / tweets on file. Don't fabricate. Example DM:

> Short version: we're shipping ShipFlare on May 14 — marketing autopilot
> for indie devs. Would you hunt it? Happy to send assets Thursday and a
> fuller note if it sounds interesting.
>
> Totally fine if not.
>
> — Yifeng

Personalization hook: "no specific signal available"

Why this works: it's honest, short, and invites the hunter to ask a
question rather than pretending to know them. Confidence is intentionally
low so the caller can decide whether to send or skip.

## Banned openings (all levels)

- "Hey" / "Hi" / "Hello"
- "Hope you're well"
- "Huge fan"
- "Love your work"
- "Quick question"
- Any greeting that doesn't name the specific hook in the first clause

## Length bands

- 120-220 words total.
- Level 1 trends to the upper end; Level 3 should stay under 140.
- Never write a 2-paragraph opener before getting to the ask.

## Follow-up posture

Single send. The skill does NOT schedule follow-ups; if the planner wants a
follow-up after 5 days, it schedules a second `plan_item` with a DIFFERENT
`personalizationHook`. Hunters unfollow founders who DM twice with the
same framing.
