/**
 * Shared helpers for unpacking MCP tool call results.
 *
 * MCP tools return `{ content: [{ type: "text", text: "..." }, ...] }`.
 * `extractText` concatenates all text blocks into a single string.
 *
 * Lifted from inline duplicates in:
 *   - find-threads-via-xai.ts
 *   - process-replies-batch.ts
 *
 * S6 may lift this further to packages/shared/mcp-result.ts when HoG /
 * future employees also need it.
 */
export function extractText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  if (!r?.content) return "";
  return r.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}
