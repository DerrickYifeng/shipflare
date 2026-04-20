# Runsheet template

Canonical 14-beat example for a launch with all four channels (x, reddit,
email, producthunt) and all assets ready.

| hourOffset | channel     | priority | action | skillName |
|---|---|---|---|---|
| -1 | producthunt | critical | Pin maker's first comment draft at top | null |
| -1 | x           | high     | Final check of launch assets + link to PH | null |
| -1 | email       | high     | Verify waitlist email is queued | null |
| 0  | producthunt | critical | Submit the launch | null |
| 0  | x           | critical | Post launch announcement | draft-single-post |
| 0  | email       | critical | Send launch-day email to waitlist | send-email |
| 1  | x           | critical | Pin the launch tweet, retweet with a thread | draft-single-post |
| 1  | reddit      | high     | Post launch thread in the one most-relevant subreddit | draft-single-post |
| 2  | x           | high     | Reply to first 10 supporters with personalized notes | draft-single-reply |
| 2  | producthunt | critical | Thank the hunter publicly in the thread | null |
| 4  | x           | high     | Mid-day update: share first PH rank screenshot | draft-single-post |
| 6  | email       | normal   | Send "what's happening" update to newer signups | send-email |
| 8  | x           | high     | Respond to top questions in the PH thread via quote tweets | draft-single-reply |
| 12 | x           | normal   | End-of-day retro prep — dump numbers to notes | null |

## Why this shape

- T-1 beats cover the readiness check. If any asset isn't queued, insert
  a prep beat before the launch slot so the check doesn't happen at T+0
  when it's too late.
- T+0 fires the three launch actions in parallel: PH submit (the moment),
  X announcement (the social anchor), waitlist email (the warm audience).
  All three are `critical` because the launch spike depends on their
  timing lining up.
- T+1 begins the sustain cadence: pin, retweet with thread, land the
  Reddit thread. Reddit gets a single post (never blast multiple subs on
  day 0 — the moderators treat it as spam).
- T+2-4 is the human beats — thanking the hunter, replying to
  supporters. These can't be automated away; the runsheet holds the
  founder accountable to the window.
- T+6 catches newer waitlist entries who missed the T+0 blast.
- T+8 bridges to reply-heavy content as the PH thread matures.
- T+12 is the retro prep beat. It's the only beat that does NOT run a
  skill — the founder is a human writing notes.

## Quiet hours

Default `constraints.quietHours = [23, 6]`. No beats land in those hours;
if the launch window crosses midnight, shift T+12 earlier or roll it to
T+24 the next morning.

## Skills referenced

All `skillName` fields must match a catalog entry:
- draft-single-post (content_post)
- draft-single-reply (content_reply)
- draft-email + send-email (email_send)
- draft-hunter-outreach (content_reply scoped to hunter DM)

Unknown skill names will cause the plan-execute dispatcher to reject the
beat at insert time. Better to leave `skillName: null` than guess.
