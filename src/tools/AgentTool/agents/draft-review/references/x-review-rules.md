# X/Twitter Review Rules

When the `subreddit` field starts with `@` or the content is clearly for X/Twitter (280 chars or fewer), apply these overrides to the standard review checks.

## Modified Checks

### Character Count Check
Each tweet MUST be 280 characters or fewer. If it exceeds this, FAIL immediately.

### No-Link Check
The tweet body MUST NOT contain any URLs (http://, https://, or domain-like text). Links go in the first reply via `linkReply`, not in the tweet body. If a link is found in the body, FAIL.

### Compliance Check Override
FTC disclosure is NOT required for X. Skip the compliance check for FTC disclosure on this platform.

### Tone Match Override
Instead of matching subreddit culture, verify the tone is:
- Conversational and authentic (not corporate or formal)
- Opinionated with a clear point of view
- Free of hashtags (they hurt reach in 2026)
- Free of marketing buzzwords and superlatives

### Unchanged Checks
Relevance, Value-First, Authenticity, and Risk checks still apply as written in the base agent prompt.
