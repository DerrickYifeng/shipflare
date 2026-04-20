# Supporter ranking notes

## Score weights

| Event kind | Weight | Rationale |
|---|---|---|
| reply     | 4 | Highest effort; spoken-word engagement |
| quote     | 4 | Amplifies to their audience with their voice |
| mention   | 4 | Proactive reference |
| repost    | 2 | Amplifies but without voice |
| bookmark  | 2 | Strong algo signal despite quiet UX |
| like      | 1 | Minimum effort; cheap signal |

Weights were chosen so a single reply outranks three likes (4 vs 3)
and a quote outranks five likes (4 vs 5 — effectively tied, quote wins
on tiebreaker).

## Filtering

- **Minimum score = 2** before inclusion. Single-like supporters are
  noise and waste the founder's thank-you capacity.
- Cap output at 30. The Today surface shows 10, the bulk thank-you
  export reads up to 30. Beyond 30 we're into "everyone who engaged"
  territory.

## Tiebreakers

1. Higher score wins.
2. If scores are equal, higher `interactionCount` wins (more distinct
   events = more sustained support).
3. If both are equal, more-recent `lastSeenAt` wins (active supporters
   > historic ones).

## `notes` field guidance

Write a note ONLY when there's a specific pattern worth flagging:

- Multi-event from the same user: "replied twice with use-case
  details"
- A particularly strong quote: "quoted the launch post with a take
  that landed 8 replies" (if the note data is available)
- A supporter from a specific cohort: "first-ever engagement from a
  `dev_tool` founder"

Leave `notes: null` when there's nothing distinctive. Don't fill every
note with "engaged consistently" — that's filler.

## Edge cases

- **Empty events**: return `{ supporters: [] }`. Do not fabricate.
- **Self-engagement**: the user's own username should never appear
  in the output; the input pipeline should filter upstream, but if a
  row slips through, drop it.
- **Bot accounts**: do not attempt to classify "is this a bot" — too
  risky. If the input doesn't filter bots, the ranking still produces
  a reasonable list.
- **Same username across platforms**: treat as separate supporters.
  Do not merge — the founder may want to thank on the specific
  platform they engaged.
