import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import type { CMO } from "../CMO";

/**
 * CMO `chat` tool — the founder's primary conversational entrypoint.
 *
 * Persists the user turn, loads conversation-scoped history (per spec D11)
 * plus identity-level `founder_context`, calls Anthropic, persists the
 * assistant reply, and returns the text as an MCP tool result. No tool
 * calls / delegation yet — those wire up in S2.4.
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
    async ({ conversationId, message }) => {
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

      // 4. Call Anthropic
      const client = new Anthropic({
        apiKey: agent.bindings.ANTHROPIC_API_KEY,
      });
      const response = await client.messages.create({
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

      const replyText = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      // 5. Persist assistant reply
      agent.sqlStorage.exec(
        `INSERT INTO founder_messages (conversation_id, role, content, ts)
         VALUES (?, ?, ?, ?)`,
        conversationId,
        "assistant",
        replyText,
        Date.now(),
      );

      // 6. Return MCP result
      return {
        content: [{ type: "text" as const, text: replyText }],
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
