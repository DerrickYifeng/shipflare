---
name: posting
description: Post approved drafts to social platforms and verify visibility
context: fork
agent: posting
model: claude-haiku-4-5-20251001
allowed-tools:
  - reddit_post
  - reddit_verify
  - reddit_submit_post
  - x_post
timeout: 60000
cache-safe: false
---

# Posting Skill

Posts approved, user-reviewed drafts to social platforms and verifies
visibility. Supports Reddit (replies and original posts) and X (tweets
and replies).

## Workflow

1. Agent receives the exact draft text and platform context
2. Agent calls the appropriate platform posting tool
3. Agent verifies visibility when possible (Reddit shadowban detection)
4. Returns structured result with success/failure status

## Input

```json
{
  "platform": "reddit",
  "draftType": "reply",
  "draftText": "The exact text to post...",
  "threadFullname": "t3_abc123",
  "subreddit": "SideProject"
}
```

## Output

Structured posting result with success status, external IDs, and
verification results.
