# Draft Review — Input & Output Format

## Input Fields

You will receive a JSON object with:
- `replyBody`: The draft content text
- `threadTitle`: The original thread/post title
- `threadBody`: The thread's body text (may be empty)
- `subreddit`: The community or platform context (e.g., subreddit name, `@username` for X)
- `productName`: The product being mentioned
- `productDescription`: What the product does
- `confidence`: The content agent's self-assessed confidence (0.0-1.0)
- `whyItWorks`: The content agent's rationale

## Output JSON Schema

Return EXACTLY this structure:

```json
{
  "verdict": "PASS",
  "score": 0.85,
  "checks": [
    {
      "name": "relevance",
      "result": "PASS",
      "detail": "Draft directly addresses OP's question about..."
    },
    {
      "name": "value_first",
      "result": "PASS",
      "detail": "3 sentences of actionable advice before product mention"
    },
    {
      "name": "tone_match",
      "result": "PASS",
      "detail": "Tone matches the platform culture"
    },
    {
      "name": "authenticity",
      "result": "PASS",
      "detail": "Reads like a real person sharing experience"
    },
    {
      "name": "compliance",
      "result": "PASS",
      "detail": "Meets platform compliance requirements"
    },
    {
      "name": "risk",
      "result": "PASS",
      "detail": "Low risk — product mention is proportionate"
    }
  ],
  "issues": ["Product mention in first sentence — move after helpful content"],
  "suggestions": ["Add a specific example before mentioning the product"]
}
```

### Field Rules

- **verdict** (required): `"PASS"`, `"FAIL"`, or `"REVISE"`
  - PASS: All checks pass, safe to post
  - REVISE: Minor issues that can be fixed — provide specific suggestions
  - FAIL: Fundamental problems — content should be regenerated
- **score** (required, number): 0.0-1.0, overall quality assessment independent of the content agent's confidence
- **checks** (required, array): ALL 6 checks must be included, each with `name`, `result` ("PASS" or "FAIL"), and `detail`
- **issues** (required, array of strings): Specific problems found (empty array if none)
- **suggestions** (required, array of strings): Actionable improvement suggestions (empty array if none)
