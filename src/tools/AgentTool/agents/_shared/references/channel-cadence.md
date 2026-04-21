<!-- Extracted from src/agents/strategic-planner.md step 5 (v2).
     Shared by growth-strategist (sets `channelMix[ch].perWeek`) and
     content-planner (allocates plan_items across those slots). Phase C
     deletes the v2 source. -->

# Channel cadence

Per-phase weekly cadence guidance for each supported channel. The
growth-strategist turns these into `channelMix[channel].perWeek` on the
strategic path; the content-planner allocates exactly that many
`plan_items` across the week, spread over the channel's
`preferredHours` and rotated across `contentPillars`.

## Hard rule

**Never emit cadence for a channel the user has not connected.** If the
input `channels` array is `['x']` only, the strategic path's
`channelMix` MUST include `x` only — drop `reddit` and `email` entries
entirely. The content-planner applies the mirror rule when allocating
items.

## X (Twitter)

| Phase       | perWeek range | Notes                                                   |
|-------------|---------------|---------------------------------------------------------|
| foundation  | 2-4           | More breaks voice. Cadence building, not reach yet.     |
| audience    | 4-6           | Warm the audience for launch; pillar rotation matters.  |
| momentum    | 5-7           | Increase the day the audience needs warming for launch. |
| launch      | 2-4 per day   | Runsheet territory, but the cadence caps the baseline.  |
| compound    | 3-5           | Case posts + retention data; not peak pre-launch noise. |
| steady      | 3-5           | Durable rhythm. No panic moves.                         |

Preferred hours: pick 2-4 UTC hours from the set
`[14, 15, 16, 17, 19, 21]` unless the voice profile specifies
otherwise. Don't stack two items in the same hour.

## Reddit

| Phase       | perWeek range | Notes                                                   |
|-------------|---------------|---------------------------------------------------------|
| any phase   | 1-2           | More than this burns karma in every sub we target.      |

Preferred hours: `[15, 19]` are the two default UTC slots — late US
afternoon and US evening — calibrated for the indie/dev subs we target.
Pick `preferredCommunities` from 2-4 subreddits that match the
`product.category`.

## Email

| Phase       | perWeek range | Notes                                                   |
|-------------|---------------|---------------------------------------------------------|
| foundation  | 0-1           | Only waitlist confirmations at this stage.              |
| audience    | 1-2           | Weekly build-in-public email + drip cadence.            |
| momentum    | 1-2           | T-1 reminder to waitlist is mandatory.                  |
| launch      | 1-2           | T-0 launch email + T+3 retrospective.                   |
| compound    | 1             | Weekly digest OR thank-you batches — not both.          |
| steady      | 1             | Weekly digest max. Respect the inbox.                   |

Preferred hours: email send-times aren't set on the strategic path —
content-planner picks hours per item based on the user's timezone
and the template the chosen email skill exposes.

## Cross-channel rules

- Pillars rotate across the week. Don't emit three items on the same
  pillar on the same day — the content-planner rejects that allocation.
- Angle diversity within a channel: spread the week's `angleMix` across
  the channel's items. A 4-post X week might emit
  `data → howto → story → claim`, not four of the same angle.
- Reddit and Email cadence operate independently of X — a 4-post X
  week does NOT imply the tactical plan also has 4 reddit or 4 email
  items. The numbers in this table are per-channel caps.
