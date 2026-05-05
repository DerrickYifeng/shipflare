// Client-safe variant of loadAgentRunHistory. Reads team_messages,
// applies redactMessageRowForClient's content/metadata transforms,
// and returns Anthropic.Messages.MessageParam[] suitable for serving
// to the browser.
//
// Used by GET /api/team/agent/[agentId]/transcript. The worker
// still uses the un-redacted loadAgentRunHistory for resume, since
// resume needs full system prompts, raw tool_use inputs, and
// architectural metadata to correctly replay state.
//
// Inclusion criteria mirror loadAgentRunHistory:
//   - team_messages where this agent is the sender OR the recipient
//   - delivered_at IS NOT NULL (excludes pending mailbox)
//   - chronological order (createdAt ASC)
//
// Redaction rules (all delegated to redact-for-client helpers):
//   - resolveOverrideContent (publicContent OR internal-trigger
//     fallback) wins over BOTH contentBlocks and row.content. This
//     mirrors redactMessageRowForClient — without it, kickoff rows
//     whose contentBlocks carry the raw goal text would leak verbatim
//     here even though the /api/team/* routes redact correctly.
//   - contentBlocks present (no override) → redactContentBlocksForClient
//     strips raw tool names, tool_use inputs, and tool_result content
//   - plain row.content with no contentBlocks and no override → pass
//     through as-is
//   - rows with both contentBlocks and content null are skipped

import type Anthropic from '@anthropic-ai/sdk';
import { and, asc, eq, isNotNull, or } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { teamMessages } from '@/lib/db/schema';
import {
  redactContentBlocksForClient,
  resolveOverrideContent,
} from '@/lib/team/redact-for-client';

export async function loadAgentRunHistoryRedactedForClient(
  agentId: string,
  db: Database,
): Promise<Anthropic.Messages.MessageParam[]> {
  const rows = await db
    .select({
      fromAgentId: teamMessages.fromAgentId,
      toAgentId: teamMessages.toAgentId,
      content: teamMessages.content,
      contentBlocks: teamMessages.contentBlocks,
      metadata: teamMessages.metadata,
    })
    .from(teamMessages)
    .where(
      and(
        or(
          eq(teamMessages.fromAgentId, agentId),
          eq(teamMessages.toAgentId, agentId),
        ),
        isNotNull(teamMessages.deliveredAt),
      ),
    )
    .orderBy(asc(teamMessages.createdAt));

  const out: Anthropic.Messages.MessageParam[] = [];
  for (const row of rows) {
    const role: 'assistant' | 'user' =
      row.fromAgentId === agentId ? 'assistant' : 'user';

    const meta = (row.metadata as Record<string, unknown> | null) ?? null;
    const override = resolveOverrideContent(meta);

    let content: Anthropic.Messages.MessageParam['content'];
    if (override !== null) {
      // Override always wins — covers publicContent + internal-trigger
      // fallback. Required because dispatchLeadMessage writes BOTH
      // `content` and `contentBlocks` for kickoff rows; preferring
      // contentBlocks here would leak the raw goal text even though
      // metadata.publicContent is set.
      content = override;
    } else if (Array.isArray(row.contentBlocks)) {
      content = redactContentBlocksForClient(
        row.contentBlocks,
      ) as Anthropic.Messages.ContentBlockParam[];
    } else if (typeof row.content === 'string') {
      content = row.content;
    } else {
      // null content + null contentBlocks → no replay value; skip
      continue;
    }

    out.push({ role, content });
  }
  return out;
}
