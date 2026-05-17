/**
 * 5.1c.17 — filter out synthetic system-role messages from the chat surface.
 *
 * The daily-relay flow (5.1c.13) injects a `role: 'system'` message with
 * `metadata: { source: 'daily-relay' }` to trigger an LLM turn from
 * `CMO.alarm()`. The founder should see the assistant's reply (the morning
 * summary) but NOT the synthetic prompt.
 *
 * Returns `false` to hide the message, `true` to render it.
 *
 * The helper accepts a minimal structural shape so it composes with `ai`'s
 * `UIMessage<unknown, ...>` without forcing callers to narrow the generic
 * `metadata` type upfront.
 */

export interface FilterableMessage {
  id: string;
  role: "user" | "assistant" | "system" | string;
  metadata?: unknown;
}

export function shouldRenderMessage(message: FilterableMessage): boolean {
  if (message.role !== "system") return true;
  const meta = message.metadata;
  if (!meta || typeof meta !== "object") return true;
  const source = (meta as { source?: unknown }).source;
  return source !== "daily-relay";
}
