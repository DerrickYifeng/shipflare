// Agent-run history loader — rebuilds an agent_runs row's prior
// conversation from team_messages so a resuming worker can pass
// `priorMessages` to runAgent.
//
// Inclusion criteria:
//   - team_messages where this agent is the sender OR the recipient
//     (fromAgentId=self OR toAgentId=self)
//   - delivered_at IS NOT NULL (excludes pending mailbox; that's
//     drained separately by mailbox-drain)
//   - chronological order (createdAt ASC)
//
// Mapping to Anthropic.Messages.MessageParam:
//   - fromAgentId === self → role: 'assistant' (the agent's prior turn)
//   - toAgentId === self   → role: 'user'      (an incoming message)
//   - rows with null content are skipped (no transcript text to replay)

import type Anthropic from '@anthropic-ai/sdk';
import { and, asc, eq, isNotNull, or } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import { teamMessages } from '@/lib/db/schema';

interface HistoryRow {
  id: string;
  fromAgentId: string | null;
  toAgentId: string | null;
  type: string;
  messageType: string;
  content: string | null;
  createdAt: Date;
}

/**
 * Load an agent_runs row's prior conversation history for resume.
 * Returns Anthropic MessageParam[] in chronological order, suitable
 * for passing to runAgent as `priorMessages` after a sleep wake-up.
 */
export async function loadAgentRunHistory(
  agentId: string,
  db: Database,
): Promise<Anthropic.Messages.MessageParam[]> {
  const rows = (await db
    .select()
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
    .orderBy(asc(teamMessages.createdAt))) as unknown as HistoryRow[];

  const messages: Anthropic.Messages.MessageParam[] = [];
  for (const row of rows) {
    if (row.content === null) continue;
    const role: 'assistant' | 'user' =
      row.fromAgentId === agentId ? 'assistant' : 'user';
    messages.push({ role, content: row.content });
  }
  return messages;
}
