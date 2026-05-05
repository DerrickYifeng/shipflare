// Mailbox drain — pulls undelivered team_messages addressed to a
// specific agent_run, marks them delivered, and returns the batch
// in createdAt order for transcript injection.
//
// Idempotent via row-lock + delivered_at marker (engine §3.5 invariant).

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { teamMessages } from '@/lib/db/schema';
import type { Database } from '@/lib/db';

export interface DrainedMessage {
  id: string;
  toAgentId: string;
  type: string;
  messageType: string;
  content: string | null;
  createdAt: Date;
}

/**
 * Drain undelivered messages addressed to `agentId`. Atomic via
 * single transaction with row-lock; safe to call concurrently
 * (other callers see locked rows and skip).
 *
 * `tick` messages are filtered out — they're wake signals only,
 * not transcript content.
 */
export async function drainMailbox(
  agentId: string,
  db: Database,
): Promise<DrainedMessage[]> {
  return db.transaction(async (tx) => {
    const rows = (await tx
      .select()
      .from(teamMessages)
      .where(
        and(
          eq(teamMessages.toAgentId, agentId),
          isNull(teamMessages.deliveredAt),
        ),
      )
      .orderBy(teamMessages.createdAt)
      .for('update')) as unknown as DrainedMessage[];

    if (rows.length === 0) return [];

    await tx
      .update(teamMessages)
      .set({ deliveredAt: new Date() })
      .where(
        inArray(
          teamMessages.id,
          rows.map((r) => r.id),
        ),
      );

    // Filter out tick messages (wake-signal-only — never enter transcript).
    return rows.filter((r) => r.messageType !== 'tick');
  });
}
