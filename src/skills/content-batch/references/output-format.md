# X Content — Input & Output Format

## Input Fields

You will receive a JSON object with:
- `contentType`: The type of content to create (`metric`, `educational`, `engagement`, `product`, `thread`)
- `topic`: The topic or angle for this content (may be null — use your judgment)
- `productName`: The product's name
- `productDescription`: What the product does
- `valueProp`: The product's value proposition
- `keywords`: Relevant keywords
- `isThread`: If true, generate a multi-tweet thread (3-7 tweets)

## Output JSON Schema

Return EXACTLY this structure:

```json
{
  "tweets": ["First tweet text", "Second tweet text (for threads)"],
  "linkReply": "https://example.com/relevant-link",
  "confidence": 0.85,
  "summaryReason": "One-sentence recap of why this post is worth shipping.",
  "whyItWorks": "Longer explanation of the content strategy",
  "contentType": "educational"
}
```

### Field Rules

- **tweets** (required, array of strings): One or more tweet texts.
  - Each tweet MUST be 280 characters or fewer. This is non-negotiable.
  - For single posts: array with one element.
  - For threads (`isThread: true`): array with 3-7 elements. Tweet #1 is the HOOK. One idea per tweet. Final tweet is a CTA or summary.
- **linkReply** (optional, string): A URL to post as the first reply. Use when a link adds value. Never put links in the tweet body.
- **confidence** (required, number): 0.0-1.0 self-assessment of quality and fit.
- **summaryReason** (optional, string): ONE sentence (<=120 chars) the user sees under the draft body before deciding to ship. Default-visible in the dashboard.
- **whyItWorks** (required, string): Longer marketing-strategy explanation. Hidden behind a "See detailed reasoning" toggle in the dashboard.
- **contentType** (required, string): Echo back the `contentType` from the input exactly as received.
