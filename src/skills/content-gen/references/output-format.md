# Reddit/HN Content — Input & Output Format

## Input Fields

You will receive a JSON object with:
- `threadTitle`: The thread's title
- `threadBody`: The thread's body text (may be empty)
- `subreddit`: Which subreddit or community this is in
- `productName`: The product's name
- `productDescription`: What the product does
- `valueProp`: The product's value proposition
- `keywords`: Relevant keywords
- `draftType`: Either `"reply"` or `"original_post"`
- `communityIntel` (optional): Community rules, hot topics, and recommended approach

## Output JSON Schema

Return EXACTLY this structure:

```json
{
  "replyBody": "The actual content text...\n\nDisclosure: I built ProductName.",
  "postTitle": "What I learned building X as a solo founder",
  "confidence": 0.85,
  "summaryReason": "One-sentence recap of why this reply fits the thread.",
  "whyItWorks": "Longer explanation of the content strategy",
  "ftcDisclosure": "Disclosure: I built ProductName."
}
```

### Field Rules

- **replyBody** (required, string): The full content text including the FTC disclosure at the end.
- **postTitle** (required for `original_post`, omit for `reply`): A title that fits the subreddit's common formats (questions, show-and-tell, tutorials, etc.)
- **confidence** (required, number): 0.0-1.0 self-assessment of quality and fit.
- **summaryReason** (optional, string): ONE sentence (<=120 chars) that a human skimming the draft queue can read to decide whether to approve. Default-visible in the dashboard.
- **whyItWorks** (required, string): Longer marketing-strategy explanation. Hidden behind a "See detailed reasoning" toggle in the dashboard.
- **ftcDisclosure** (required, string): The exact disclosure text used, e.g., "Disclosure: I'm affiliated with [product]" or "Full disclosure: I work on [product]."
