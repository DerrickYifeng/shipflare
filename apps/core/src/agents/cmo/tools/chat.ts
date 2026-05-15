import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import type { CMO } from "../CMO";

/**
 * CMO `chat` tool — the founder's primary conversational entrypoint.
 *
 * Persists the user turn, loads conversation-scoped history (per spec D11)
 * plus identity-level `founder_context`, calls Anthropic with streaming,
 * pushes chunks via MCP `notifications/progress`, persists the assistant
 * reply, and returns the full text as an MCP tool result so non-streaming
 * clients still work.
 *
 * Streaming: if the caller passes a `progressToken` in `_meta`, each text
 * delta is sent as a `notifications/progress` notification with the chunk
 * in `params.message`. Failures are best-effort (logged, not thrown).
 *
 * Scope rules (D11):
 * - `founder_messages` filter by `conversation_id`; chat history resets
 *   per new conversation.
 * - `founder_context` is identity-level and ALWAYS injected into the
 *   system prompt regardless of conversation.
 */
export function registerChatTool(agent: CMO): void {
  agent.server.registerTool(
    "chat",
    {
      description:
        "Send a message to the CMO. Returns the assistant reply. " +
        "Use startNewConversation first to get a conversationId.",
      inputSchema: {
        conversationId: z.string().min(1),
        message: z.string().min(1),
      },
    },
    async ({ conversationId, message }, extra) => {
      const ts = Date.now();

      // 1. Persist user message
      agent.sqlStorage.exec(
        `INSERT INTO founder_messages (conversation_id, role, content, ts)
         VALUES (?, ?, ?, ?)`,
        conversationId,
        "user",
        message,
        ts,
      );

      // 2. Load conversation-scoped history
      const history = agent.sqlStorage
        .exec<{ role: string; content: string }>(
          `SELECT role, content
           FROM founder_messages
           WHERE conversation_id = ?
           ORDER BY ts ASC`,
          conversationId,
        )
        .toArray();

      // 3. Load identity-level founder_context (cross-conversation)
      const contextRows = agent.sqlStorage
        .exec<{ key: string; value: string }>(
          "SELECT key, value FROM founder_context",
        )
        .toArray();
      const founderContext = Object.fromEntries(
        contextRows.map((r) => [r.key, r.value]),
      );

      // 3b. P2-D: Load active long-term memories (opt-in, cross-conversation).
      // Oldest-first so numbered list stays stable as new memories accrue.
      const memories = agent.sqlStorage
        .exec<{ content: string }>(
          "SELECT content FROM cross_conversation_memory WHERE active = 1 ORDER BY added_at",
        )
        .toArray();

      // 4. Call Anthropic with streaming.
      // `progressToken` lives in the request's `_meta` object, exposed via
      // the `extra._meta` field that `registerTool` passes to the handler.
      const progressToken = extra._meta?.progressToken;

      const client = new Anthropic({
        apiKey: agent.bindings.ANTHROPIC_API_KEY,
      });

      const stream = client.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: buildSystemPrompt(founderContext, memories),
        messages: history.map((h) => ({
          role: (h.role === "assistant" ? "assistant" : "user") as
            | "user"
            | "assistant",
          content: h.content,
        })),
      });

      let acc = "";
      let chunkIdx = 0;

      // Consume the stream, accumulating the full text and pushing progress
      // notifications when the caller supplied a progressToken.
      stream.on("text", (delta: string) => {
        acc += delta;
        if (progressToken !== undefined) {
          chunkIdx += 1;
          // Fire-and-forget: progress notifications are best-effort.
          // We do NOT await here — the text handler is synchronous and
          // sendNotification returns a promise we handle with .catch().
          extra
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: chunkIdx,
                message: delta,
              },
            })
            .catch((err: unknown) => {
              console.warn("[chat] progress notification failed:", err);
            });
        }
      });

      // Wait for the stream to fully complete.
      await stream.finalMessage();

      // 5. Persist assistant reply (using the fully accumulated text).
      agent.sqlStorage.exec(
        `INSERT INTO founder_messages (conversation_id, role, content, ts)
         VALUES (?, ?, ?, ?)`,
        conversationId,
        "assistant",
        acc,
        Date.now(),
      );

      // 6. Return MCP result — the full text so non-streaming clients get it.
      return {
        content: [{ type: "text" as const, text: acc }],
      };
    },
  );
}

/**
 * Build the CMO system prompt from identity-level founder_context KV +
 * any opt-in cross-conversation memories (P2-D).
 *
 * Pulled out so we can unit-test the assembly independently of an
 * Anthropic call. Each field has a sensible fallback so the prompt is
 * coherent even before the founder has filled in the context.
 *
 * `memories` is the list of `cross_conversation_memory` rows (active=1).
 * The block is omitted entirely when the founder hasn't opted in any
 * memories yet — no point telling the model "always remember: (nothing)".
 */
export function buildSystemPrompt(
  ctx: Record<string, string>,
  memories: ReadonlyArray<{ content: string }> = [],
): string {
  const productName = ctx.productName ?? "the founder's product";
  const productDescription = ctx.productDescription ?? "(not yet set)";
  const voice =
    ctx.voice ?? "default — friendly, direct, no marketing fluff";

  const memoryBlock =
    memories.length > 0
      ? `\n\nThings to always remember about ${productName}:\n${memories
          .map((m, i) => `${i + 1}. ${m.content}`)
          .join("\n")}`
      : "";

  return `You are the CMO for ${productName}'s AI marketing team.

Product: ${productName} — ${productDescription}
Voice: ${voice}

Your role is to orchestrate. You delegate strategic planning to Head of Growth,
operational work (drafts, replies, discovery) to Social Media Manager.

Right now you do NOT have delegation tools wired up — that comes in a later
task. Just chat conversationally with the founder, ask clarifying questions,
explain that delegation isn't online yet if they ask for something that needs
specialist work.

Keep replies under 3 sentences unless the founder asks for more detail.${memoryBlock}`.trim();
}
