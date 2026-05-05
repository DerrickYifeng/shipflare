// Reconcile-mailbox cron — durable backstop for wake() failures.
//
// Every minute, finds agent_runs that have undelivered messages older than
// 30 seconds and re-enqueues them via wake(). Catches enqueue failures from
// wake() (transient BullMQ errors, dedupe-window misfires, etc.) so a stuck
// teammate eventually resumes within ~1 minute even if the original
// SendMessage / Sleep wake never landed in Redis.

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { wake } from './lib/wake';
import { createLogger } from '@/lib/logger';

const log = createLogger('reconcile-mailbox');

interface OrphanRow {
  to_agent_id: string;
}

export async function processReconcileMailbox(): Promise<void> {
  const orphans = (await db.execute(sql`
    SELECT DISTINCT to_agent_id
    FROM team_messages
    WHERE delivered_at IS NULL
      AND to_agent_id IS NOT NULL
      AND created_at < now() - interval '30 seconds'
  `)) as unknown as OrphanRow[];

  if (orphans.length === 0) return;

  log.info(`reconciling ${orphans.length} mailbox orphan(s)`);
  for (const row of orphans) {
    try {
      await wake(row.to_agent_id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`wake failed during reconcile for ${row.to_agent_id}: ${msg}`);
    }
  }
}
