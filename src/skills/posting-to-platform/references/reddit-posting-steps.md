# Reddit Posting Steps

## Reddit-Specific Input Fields

- `threadFullname`: Reddit fullname of the thread (for replies, e.g., `"t3_abc123"`)
- `subreddit`: Subreddit name (for original posts)
- `postTitle`: Title of the post (for original posts)

## For Replies (draftType = "reply")

1. Use `reddit_post` with the thread fullname and exact draft text
2. Wait, then use `reddit_verify` with the returned comment ID
3. Report the result — detect shadowban if comment exists but is removed

## For Original Posts (draftType = "original_post")

1. Use `reddit_submit_post` with the subreddit, title, and exact draft text
2. Report the result
