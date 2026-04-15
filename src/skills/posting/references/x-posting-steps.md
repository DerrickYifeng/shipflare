# X Posting Steps

## X-Specific Input Fields

- `tweetId`: Tweet ID to reply to (for replies)
- `topic`: Topic/hashtag context (for original posts)

## For Replies (draftType = "reply")

1. Use `x_post` with the draft text and `replyToTweetId` set to the tweet ID
2. Report the result

## For Original Posts (draftType = "original_post")

1. Use `x_post` with just the draft text (no replyToTweetId)
2. Report the result

## Character Limit

X has a 280 character limit. If the draft exceeds it, report failure. Do NOT truncate.
