# Posting — Input & Output Format

## Input Fields

You will receive a JSON object with:
- `platform`: The target platform (`"reddit"` or `"x"`)
- `draftType`: Either `"reply"` or `"original_post"`
- `draftText`: The EXACT text to post (already approved by the user)

Platform-specific fields are described in the platform posting steps references.

## Output JSON Schema

Return EXACTLY this structure:

```json
{
  "success": true,
  "draftType": "reply",
  "commentId": "xyz789",
  "postId": null,
  "permalink": "/r/SideProject/comments/.../comment/xyz789/",
  "url": null,
  "verified": true,
  "shadowbanned": false
}
```

If posting fails:

```json
{
  "success": false,
  "draftType": "reply",
  "error": "Thread is locked",
  "commentId": null,
  "postId": null,
  "permalink": null,
  "url": null,
  "verified": false,
  "shadowbanned": false
}
```

### Field Rules

- **success** (required, boolean): Whether the post was published successfully.
- **draftType** (optional, string): `"reply"` or `"original_post"`, echoed from input.
- **commentId** (required, string | null): The ID of the posted comment (for replies).
- **postId** (optional, string | null): The ID of the new post (for original posts).
- **permalink** (required, string | null): The relative URL path (Reddit).
- **url** (optional, string | null): The full URL (X).
- **verified** (required, boolean): Whether visibility was confirmed.
- **shadowbanned** (required, boolean): Whether shadowban was detected.
- **error** (optional, string): Error message if posting failed.
