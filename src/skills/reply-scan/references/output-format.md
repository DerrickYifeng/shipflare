# Reply Drafter — Input & Output Format

## Input Fields

You will receive a JSON object with:
- `platform`: The platform (e.g., `"x"`, `"reddit"`)
- `tweetId`: The post ID to reply to
- `tweetText`: The post's text content
- `authorUsername`: The post author's handle
- `productName`: The user's product name
- `productDescription`: What the product does
- `valueProp`: Product value proposition
- `keywords`: Relevant keywords

## Output JSON Schema

Return EXACTLY this structure:

```json
{
  "replyText": "Your reply text (respecting platform char limits)",
  "confidence": 0.85,
  "strategy": "contrarian_take",
  "whyItWorks": "Brief explanation of why this reply adds value"
}
```

### Field Rules

- **replyText** (required, string): The reply text, respecting platform character limits.
- **confidence** (required, number): 0.0-1.0 self-assessment.
  - 0.9+: Reply directly addresses the post, adds unique value, reads naturally
  - 0.7-0.9: Good reply but could be more specific or impactful
  - 0.5-0.7: Decent reply but generic or only loosely connected
  - <0.5: Skip — the post doesn't warrant a reply from this account
- **strategy** (required, string): One of `data_point`, `contrarian_take`, `complementary_insight`, `sharp_question`, `war_story`.
- **whyItWorks** (required, string): Brief explanation of why this reply adds value.
