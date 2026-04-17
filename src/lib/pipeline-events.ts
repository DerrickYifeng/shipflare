import { db } from '@/lib/db';
import {
  pipelineEvents,
  threadFeedback,
  type NewPipelineEvent,
  type NewThreadFeedback,
} from '@/lib/db/schema';
import { sql } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('pipeline-events');

/**
 * Stage enum as a string-literal union. Not a pg enum so we can add stages
 * without a migration — the DB column is plain `text`. Keep in sync with
 * the dashboard funnel view so unknown stages don't silently disappear.
 */
export type PipelineStage =
  | 'discovered'
  | 'gate_passed'
  | 'draft_created'
  | 'reviewed'
  | 'approved'
  | 'posted'
  | 'engaged'
  | 'failed';

export type RecordPipelineEventInput = Omit<
  NewPipelineEvent,
  'id' | 'enteredAt'
> & {
  stage: PipelineStage;
};

/**
 * Insert one pipeline_events row. Swallows errors — pipeline telemetry
 * MUST NOT break the main flow. All callers are fire-and-forget.
 *
 * Returns true on success, false on failure (for callers that want to
 * branch, though most should just ignore the return value).
 */
export async function recordPipelineEvent(
  input: RecordPipelineEventInput,
): Promise<boolean> {
  try {
    await db.insert(pipelineEvents).values(input);
    return true;
  } catch (err) {
    log.warn('Failed to record pipeline event', {
      stage: input.stage,
      userId: input.userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Insert many pipeline_events rows in a single round-trip. Same error-swallow
 * semantics as `recordPipelineEvent` — telemetry MUST NOT break the main flow.
 *
 * Use this when a caller has N events to record in a tight loop (e.g. discovery
 * fan-out emitting one 'discovered' row per newly-inserted thread, + one
 * 'gate_passed' row per gate-passing thread). Avoids N round-trips.
 */
export async function recordPipelineEventsBulk(
  inputs: RecordPipelineEventInput[],
): Promise<boolean> {
  if (inputs.length === 0) return true;
  try {
    await db.insert(pipelineEvents).values(inputs);
    return true;
  } catch (err) {
    log.warn('Failed to bulk record pipeline events', {
      count: inputs.length,
      firstStage: inputs[0]?.stage,
      userId: inputs[0]?.userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Upsert a thread_feedback row for the discovery optimization loop. Unique
 * per (userId, threadId) — later labels overwrite earlier ones so a
 * "post" event supersedes an earlier "approve".
 *
 * Errors are swallowed for the same reason as recordPipelineEvent.
 */
export async function recordThreadFeedback(
  input: Omit<NewThreadFeedback, 'id' | 'createdAt'>,
): Promise<boolean> {
  try {
    await db
      .insert(threadFeedback)
      .values(input)
      .onConflictDoUpdate({
        target: [threadFeedback.userId, threadFeedback.threadId],
        set: {
          userAction: input.userAction,
          createdAt: sql`now()`,
        },
      });
    return true;
  } catch (err) {
    log.warn('Failed to record thread feedback', {
      threadId: input.threadId,
      userId: input.userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
