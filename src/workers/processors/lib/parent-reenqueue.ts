// Atomic parent re-enqueue on child completion (Phase D4).
//
// When a teammate completes (terminal status) and `synthAndDeliverNotification`
// inserts the `<task-notification>` into the parent's mailbox, we must also:
//
//   1. Remove the completing child's id from the parent's `waiting_for` array.
//   2. If the array drained to empty AND status was `waiting_for_children`,
//      atomically transition to `running` so the next wake actually re-enters
//      `leadStep` (D3's `runAgentTurn_durable` ignores wakes on
//      `waiting_for_children` with `cardinality(waiting_for) > 0`).
//   3. Tell the caller whether THIS call was the "last child" — only true on
//      the `waiting_for_children → running` transition. Concurrent completions
//      racing on the final child must produce exactly one `shouldWake=true`
//      so we don't burn two parent wakes on a single unblocking event.
//
// Atomicity comes from a single `UPDATE ... RETURNING` statement: Postgres
// serializes concurrent UPDATEs against the same row via the row-level lock
// it takes during execution, so the second caller observes the cardinality
// decrement of the first. Only the caller that drains the array AND flips
// status returns `shouldWake=true`.

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { createLogger } from '@/lib/logger';

const log = createLogger('parent-reenqueue');

// `& Record<string, unknown>` is required for Drizzle's `db.execute<T>()`
// generic, which constrains the row type to an index-signature shape so
// the returned rows can be looked up by arbitrary column names.
type ReenqueueRow = {
  new_remaining: number;
  new_status: string;
  // `true` iff THIS UPDATE flipped status from 'waiting_for_children' to
  // 'running'. Distinct from "post-image status is 'running'" because a
  // legacy parent that was already 'running' with empty `waiting_for`
  // must NOT report a transition.
  transitioned: boolean;
} & Record<string, unknown>;

/**
 * Atomically remove `childAgentId` from the parent's `waiting_for` array.
 * If the resulting array is empty AND the parent was in
 * `waiting_for_children`, the same UPDATE flips status to `running`.
 *
 * Returns `true` only on the `waiting_for_children → running` transition —
 * the caller should `wake(parentAgentId, 'priority')` in that case so the
 * step function actually resumes. Returns `false` when:
 *   - The parent's `waiting_for` still has siblings (other children running).
 *   - The child wasn't in `waiting_for` (idempotent no-op; `array_remove`
 *     leaves the array unchanged when the value is absent).
 *   - The parent isn't in `waiting_for_children` (legacy / already-running).
 *   - The parent row doesn't exist (FK already deleted).
 *
 * Concurrent callers racing on the last child: Postgres row-lock serialises
 * the UPDATEs; the caller that observes the array drained AND the status
 * still on `waiting_for_children` wins; the other sees status='running'
 * (already transitioned) and returns `false`.
 */
export async function removeChildAndMaybeWake(
  parentAgentId: string,
  childAgentId: string,
): Promise<boolean> {
  // Single UPDATE...RETURNING with a snapshot CTE for atomicity. The CTE
  // takes a row-level FOR UPDATE lock and captures the pre-image
  // (`prev_status`, `prev_waiting_for`) under that lock; the UPDATE then
  // applies the mutation and the outer SELECT reports both pre- and
  // post-image values in one trip. Postgres's row lock serialises
  // concurrent callers against the same parent — the second caller's
  // CTE blocks until the first commits, then observes the first's
  // post-image as ITS pre-image.
  //
  // Why not just `RETURNING status`? In Postgres, RETURNING sees
  // POST-image column values, so `RETURNING status` after a flipping
  // CASE would return 'running' for a legacy parent that was already
  // 'running' with empty waiting_for — indistinguishable from a real
  // transition. The CTE makes the pre-image explicit.
  const result = await db.execute<ReenqueueRow>(sql`
    WITH prev AS (
      SELECT id, status AS prev_status, waiting_for AS prev_waiting_for
      FROM agent_runs
      WHERE id = ${parentAgentId}
      FOR UPDATE
    ),
    upd AS (
      UPDATE agent_runs ar
      SET
        waiting_for = array_remove(ar.waiting_for, ${childAgentId}),
        status = CASE
          WHEN cardinality(array_remove(ar.waiting_for, ${childAgentId})) = 0
            AND ar.status = 'waiting_for_children'
          THEN 'running'
          ELSE ar.status
        END,
        last_active_at = now()
      FROM prev
      WHERE ar.id = prev.id
      RETURNING
        cardinality(ar.waiting_for) AS new_remaining,
        ar.status AS new_status,
        prev.prev_status
    )
    SELECT
      new_remaining,
      new_status,
      (prev_status = 'waiting_for_children' AND new_remaining = 0) AS transitioned
    FROM upd
  `);

  const row = result[0];
  if (!row) {
    log.warn(
      `removeChildAndMaybeWake: parent ${parentAgentId} not found (child=${childAgentId}); treating as no-op`,
    );
    return false;
  }

  // shouldWake fires iff THIS call performed the
  // `waiting_for_children → running` transition. The `transitioned` flag
  // is computed against pre-image state (`status='waiting_for_children'`
  // before the UPDATE) AND post-image cardinality (drained to empty), so
  // concurrent callers racing on the same parent converge to exactly one
  // `true`: the second caller's pre-image status is 'running' (the
  // first caller's UPDATE already flipped it), so its `transitioned`
  // expression evaluates false. Legacy parents (already 'running', empty
  // waiting_for) also return false — no transition fires.
  return row.transitioned === true;
}
