/**
 * Shared helper for unpacking MCP tool call results.
 *
 * MCP tools return `{ content: [{ type: "text", text: "..." }, ...] }`.
 * `extractText` concatenates all text blocks into a single string. Mirrors
 * the SMM/HoG copy of this helper — kept per-agent in Phase 2 P2-B to avoid
 * pre-emptively widening `@shipflare/shared`'s surface; lift to shared when
 * a fourth caller appears.
 */
export function extractText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  if (!r?.content) return "";
  return r.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}
