# Channel cadence

Per-phase cadence guidance for each supported channel. Two knobs:

- **Per-week post count (`thesisArc[i].posts.{ch}`)** — number of
  ORIGINAL POSTS to schedule for THIS WEEK on this channel. Lives on
  the thesis arc, NOT in `channelMix`, so each week can ramp
  differently (foundation weeks small, momentum/launch weeks larger).
  The content-planner emits exactly that many `kind: 'content_post'`
  plan_items for the channel, spread over the channel's
  `preferredHours` and rotated across `contentPillars`.
- **`channelMix[ch].repliesPerDay`** — daily REPLY budget. The
  generating-strategy skill sets this; content-planner emits ONE
  `kind: 'content_reply'` plan_item per day per channel with
  `params.targetCount = repliesPerDay`. The daily reply-sweep cron
  walks those slots and runs `discovery-agent` + `content-manager`
  until `targetCount` drafts exist (max 3 inner attempts per session).
  Nullish/0 disables reply automation for the channel — used for
  Reddit, where high reply volume invites shadowbans.

The tables below give per-phase RANGES; pick a value within the range
when emitting `thesisArc[i].posts.{ch}` for the corresponding week.

## Hard rule

**Never emit settings for a channel the user has not connected.** If
the input `channels` array is `['x']` only, the strategic path's
`channelMix` MUST include `x` only — drop `reddit` and `email` entries
entirely, and DO NOT emit `posts.reddit` / `posts.email` on any week.
The content-planner applies the mirror rule when allocating items.

## X (Twitter)

### Per-week posts (`thesisArc[i].posts.x`)

| Phase       | per-week range | Notes                                                   |
|-------------|----------------|---------------------------------------------------------|
| foundation  | 2-4            | More breaks voice. Cadence building, not reach yet.     |
| audience    | 4-6            | Warm the audience for launch; pillar rotation matters.  |
| momentum    | 5-7            | Increase the day the audience needs warming for launch. |
| launch      | 2-4 per day    | Runsheet territory, but the cadence caps the baseline.  |
| compound    | 3-5            | Case posts + retention data; not peak pre-launch noise. |
| steady      | 3-5            | Durable rhythm. No panic moves.                         |

Pick a value within the phase range and emit it as
`thesisArc[i].posts.x` for each week. Ramp across the arc — the first
foundation week sits at the bottom of the range, the last at the top,
or step through the phase changes as the arc moves toward launch.

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

Within each range, generating-strategy skill picks based on `product.usersBucket`
(roughly: 0–500 → top of range, 500–2k → middle, 2k+ → bottom). Reply
slots all share the channel's first `preferredHour` for the day —
content-planner emits ONE `content_reply` plan_item per day per channel,
not N per day.

## Reddit

### Per-week posts (`thesisArc[i].posts.reddit`)

| Phase       | per-week range | Notes                                                |
|-------------|----------------|------------------------------------------------------|
| any phase   | 1-2            | More than this burns karma in every sub we target.   |

Pick a value within range and emit as `thesisArc[i].posts.reddit`. A
ramp like `1, 1, 2, 2` across a 4-week arc is healthier than a flat 2.

Preferred hours: `[15, 19]` are the two default UTC slots — late US
afternoon and US evening — calibrated for the indie/dev subs we target.
Pick `preferredCommunities` from 2-4 subreddits that match the
`product.category`.

### `repliesPerDay` (daily reply budget)

Reddit is lower-velocity than X. Mods notice repeat commenters and the
same handle hitting many subs in a day is the spammer pattern. The
shadowban risk is about **velocity per subreddit + low-effort drive-by
replies**, not absolute count — quality replies in niche subs are how
founders actually find customers there.

| Phase       | range | Per-subreddit cap | Pick UPPER end if                       | Pick LOWER end if                          |
|-------------|-------|-------------------|-----------------------------------------|--------------------------------------------|
| foundation  | 2-3   | ≤1 / sub / day    | account >30d old, some karma            | brand-new account, <30d, low karma         |
| audience    | 4-5   | ≤1 / sub / day    | active in 4+ relevant subs              | active in 1-2 subs                         |
| momentum    | 5-7   | ≤2 / sub / day    | launch-week amplification               | mod-strict subs                            |
| launch      | 3-5   | ≤2 / sub / day    | aggressive launch-week amplification    | conservative profile                       |
| compound    | 2-4   | ≤1 / sub / day    | sustained presence                      | maintenance mode                           |
| steady      | 1-3   | ≤1 / sub / day    | relationship maintenance                | low-touch ongoing rhythm                   |

Pick a value within the range and emit as
`channelMix.reddit.repliesPerDay`. The per-subreddit cap is enforced
downstream by discovery + the existing `replyAuthorCooldownDays` (7d)
so we never double-tap an author or flood a single sub. Foundation
default is **3** unless the founder profile clearly signals
brand-new / low-karma — drop to 2 in that case.

## Email

### Per-week sends (`thesisArc[i].posts.email`)

| Phase       | per-week range | Notes                                                  |
|-------------|----------------|--------------------------------------------------------|
| foundation  | 0-1            | Only waitlist confirmations at this stage.             |
| audience    | 1-2            | Weekly build-in-public email + drip cadence.           |
| momentum    | 1-2            | T-1 reminder to waitlist is mandatory.                 |
| launch      | 1-2            | T-0 launch email + T+3 retrospective.                  |
| compound    | 1              | Weekly digest OR thank-you batches — not both.         |
| steady      | 1              | Weekly digest max. Respect the inbox.                  |

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
