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
//   - contentBlocks present → redactContentBlocksForClient strips raw
//     tool names, tool_use inputs, and tool_result content
//   - metadata.publicContent present → swap raw row.content for the
//     founder-facing summary (e.g. kickoff prompts → "Setting up
//     your week-1 plan...")
//   - plain row.content with no contentBlocks and no publicContent →
//     pass through as-is
//   - rows with both contentBlocks and content null are skipped

import type Anthropic from '@anthropic-ai/sdk';
import { and, asc, eq, isNotNull, or } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { teamMessages } from '@/lib/db/schema';
import { redactContentBlocksForClient } from '@/lib/team/redact-for-client';

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
    const publicContent =
      meta && typeof meta.publicContent === 'string'
        ? meta.publicContent
        : null;

    let content: Anthropic.Messages.MessageParam['content'];
    if (Array.isArray(row.contentBlocks)) {
      content = redactContentBlocksForClient(
        row.contentBlocks,
      ) as Anthropic.Messages.ContentBlockParam[];
    } else if (publicContent) {
      content = publicContent;
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
