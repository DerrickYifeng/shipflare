<!-- Extracted from src/agents/strategic-planner.md step 5 (v2).
     Shared by growth-strategist (sets `channelMix[ch].perWeek` +
     `channelMix[ch].repliesPerDay`) and content-planner (allocates
     plan_items across those slots). Phase C deletes the v2 source. -->

# Channel cadence

Per-phase cadence guidance for each supported channel. Two knobs per
channel:

- **`perWeek`** — number of ORIGINAL POSTS to schedule across the week.
  The growth-strategist sets this; content-planner emits exactly that
  many `kind: 'content_post'` plan_items, spread over the channel's
  `preferredHours` and rotated across `contentPillars`.
- **`repliesPerDay`** — daily REPLY budget. The growth-strategist sets
  this; content-planner emits ONE `kind: 'content_reply'` plan_item per
  day per channel with `params.targetCount = repliesPerDay`. The
  daily reply-sweep cron walks those slots and runs
  `discovery-agent` + `community-manager` until `targetCount` drafts
  exist (max 3 inner attempts per session). Nullish/0 disables reply
  automation for the channel — used for Reddit, where high reply volume
  invites shadowbans.

## Hard rule

**Never emit cadence for a channel the user has not connected.** If the
input `channels` array is `['x']` only, the strategic path's
`channelMix` MUST include `x` only — drop `reddit` and `email` entries
entirely. The content-planner applies the mirror rule when allocating
items.

## X (Twitter)

### `perWeek` (original posts)

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

### `repliesPerDay` (daily reply budget)

The 70/30 reply strategy is the dominant indie-hacker growth lever:
70-80% of engagement time on strategic replies to accounts 2-10× the
founder's follower count, 20-30% on original posts. Reply volume
matters most when the audience is small.

| Phase       | range | Pick UPPER end if                              | Pick LOWER end if                          |
|-------------|-------|------------------------------------------------|--------------------------------------------|
| foundation  | 5-10  | 0–500 followers — reply-heavy is the only way out from zero | already has audience from prior product / 2k+ followers |
| audience    | 8-15  | 90-31 days pre-launch active audience build, 0–500 followers | day-job constraints / 2k+ followers |
| momentum    | 10-18 | 30-8 days pre-launch waitlist drive, sub-500 followers | 2k+ followers, audience already warm |
| launch      | 5-10  | aggressive launch-week amplification | attention split with own-post comments + 5-10 builder engagement |
| compound    | 4-8   | active sustained growth | maintenance mode |
| steady      | 3-6   | active relationship maintenance | low-touch ongoing rhythm |

Within each range, growth-strategist picks based on `product.usersBucket`
(roughly: 0–500 → top of range, 500–2k → middle, 2k+ → bottom). Reply
slots all share the channel's first `preferredHour` for the day —
content-planner emits ONE `content_reply` plan_item per day per channel,
not N per day.

## Reddit

### `perWeek` (original posts)

| Phase       | perWeek range | Notes                                                   |
|-------------|---------------|---------------------------------------------------------|
| any phase   | 1-2           | More than this burns karma in every sub we target.      |

Preferred hours: `[15, 19]` are the two default UTC slots — late US
afternoon and US evening — calibrated for the indie/dev subs we target.
Pick `preferredCommunities` from 2-4 subreddits that match the
`product.category`.

### `repliesPerDay` — leave NULL or 0

Reddit punishes volume reply posters with shadowbans and comment
ghosting. Quality over quantity is the only durable strategy. **Do not
set `channelMix.reddit.repliesPerDay`** — leave it null/undefined so
the daily cron skips reddit reply automation. Reply opportunities on
reddit are surfaced by the discovery pipeline as candidate threads, but
drafting cadence stays human-driven.

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
