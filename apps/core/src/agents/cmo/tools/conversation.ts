import { z } from "zod";
import type { CMO } from "../CMO";

/**
 * Conversation tools — manage chat threads with the founder.
 *
 * Per spec D11 (Claude.ai-style conversation scope): each conversation has
 * its own chat history. Founder triggers a new conversation explicitly via
 * `startNewConversation`. Old conversations stay accessible via
 * `listConversations` but their messages don't pollute the new chat's
 * context.
 *
 * Tools live outside the class and use `agent.sqlStorage` (the public
 * getter exposed by CMO) — DO NOT reach into `agent.ctx.storage.sql` here
 * because `ctx` is protected on the parent DurableObject.
 */
export function registerConversationTools(agent: CMO): void {
  agent.server.registerTool(
    "startNewConversation",
    {
      description:
        "Begin a new conversation thread. Chat history resets; " +
        "founder_context + roster + strategic plan persist.",
      inputSchema: {
        title: z.string().optional(),
      },
    },
    async ({ title }) => {
      const id = crypto.randomUUID();
      agent.sqlStorage.exec(
        `INSERT INTO conversations (id, started_at, title)
         VALUES (?, ?, ?)`,
        id,
        Date.now(),
        title ?? null,
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ conversationId: id }) },
        ],
      };
    },
  );

  agent.server.registerTool(
    "listConversations",
    {
      description: "List active (non-archived) conversations, newest first.",
      inputSchema: {
        limit: z.number().int().positive().max(100).default(20),
      },
    },
    async ({ limit }) => {
      const rows = agent.sqlStorage
        .exec<{
          id: string;
          started_at: number;
          ended_at: number | null;
          title: string | null;
        }>(
          `SELECT id, started_at, ended_at, title
           FROM conversations
           WHERE archived = 0
           ORDER BY started_at DESC
           LIMIT ?`,
          limit,
        )
        .toArray();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows) }],
      };
    },
  );
}
