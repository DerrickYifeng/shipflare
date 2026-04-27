// Phase B Day 4 — team-run adapter for the onboarding flow.
//
// Wraps the plumbing needed to trigger a team_run from /api/onboarding/plan
// and surface the strategic path back to the SSE consumer in the shape the
// UI already expects (`{ type: 'strategic_done', path: StrategicPath }`).
//
// Flow:
//   1. Caller passes a committed productId (must exist in `products`).
//   2. `ensureTeamExists` upserts the team + base roster.
//   3. `enqueueTeamRun({ trigger: 'onboarding', goal })` creates a
//      `team_runs` row and pushes a BullMQ job.
//   4. The caller subscribes to `team:${teamId}:messages` and `waitFor...`
//      translates the tool_call / tool_result / completion events into
//      the onboarding UI's event shape.
//
// This helper stops at "translate events". The actual HTTP SSE stream is
// owned by the route handler that wires us up — keeping the two layers
// separate means the adapter can be tested without an HTTP round-trip.

import { and, eq } from 'drizzle-orm';
import { createPubSubSubscriber } from '@/lib/redis';
import { teamMessagesChannel } from '@/tools/SendMessageTool/SendMessageTool';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/db';
import { strategicPaths } from '@/lib/db/schema';
import type { StrategicPath } from '@/tools/schemas';
import { strategicPathSchema } from '@/tools/schemas';

const log = createLogger('lib:onboarding-team-run');

export interface TeamRunStrategicEvent {
  type: 'strategic_done';
  path: StrategicPath;
}

export interface TeamRunErrorEvent {
  type: 'error';
  error: string;
}

export interface TeamRunHeartbeatEvent {
  type: 'heartbeat';
}

export type OnboardingTeamRunEvent =
  | TeamRunStrategicEvent
  | TeamRunErrorEvent
  | TeamRunHeartbeatEvent;

/**
 * Extract `pathId` from the tool_result content. The write_strategic_path
 * tool returns `{ pathId, persisted }`; the Redis payload stores the
 * content as a JSON string.
 */
function parsePathIdFromToolResult(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  try {
    const obj = JSON.parse(content) as { pathId?: unknown };
    return typeof obj.pathId === 'string' && obj.pathId.length > 0
      ? obj.pathId
      : null;
  } catch {
    return null;
  }
}

/**
 * Load a persisted strategic_paths row by id, validate its snapshot
 * against strategicPathSchema, and push the terminal events. Used by
 * the tool_result fallback when the tool_call input was too loose for
 * the SSE client's strict schema but the tool itself coerced + wrote
 * a valid row.
 */
async function loadPathAndPush(
  pathId: string,
  push: (item:
    | { type: 'strategic_done'; path: StrategicPath }
    | { type: 'error'; error: string }
    | { type: '__done' }) => void,
): Promise<void> {
  const [row] = await db
    .select()
    .from(strategicPaths)
    .where(eq(strategicPaths.id, pathId))
    .limit(1);
  if (!row) {
    push({
      type: 'error',
      error: `strategic_paths row not found for pathId=${pathId}`,
    });
    push({ type: '__done' });
    return;
  }
  // The persisted row mirrors strategicPathSchema's shape across the
  // jsonb columns. Re-validate so the SSE consumer gets a typed
  // StrategicPath.
  const candidate = {
    narrative: row.narrative,
    milestones: row.milestones,
    thesisArc: row.thesisArc,
    contentPillars: row.contentPillars,
    channelMix: row.channelMix,
    phaseGoals: row.phaseGoals,
  };
  const v = strategicPathSchema.safeParse(candidate);
  if (v.success) {
    push({ type: 'strategic_done', path: v.data });
    push({ type: '__done' });
    return;
  }
  push({
    type: 'error',
    error: `strategic_paths row failed schema validation: ${v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
  });
  push({ type: '__done' });
}

/**
 * Subscribe to a team's Redis pub/sub channel and yield UI-shaped events
 * until the first `write_strategic_path` tool_call lands (success) or the
 * team-run's `completion`/`error` message arrives (either outcome).
 *
 * Callers pipe the yielded events into their SSE stream. The async iterator
 * terminates on its own — callers don't need to clean up a subscriber.
 */
export async function* subscribeToStrategicPathEvents(
  teamId: string,
  runId: string,
  opts: { timeoutMs?: number } = {},
): AsyncGenerator<OnboardingTeamRunEvent, void, void> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const subscriber = createPubSubSubscriber();
  const channel = teamMessagesChannel(teamId);

  type QueueItem = OnboardingTeamRunEvent | { type: '__done' };
  const queue: QueueItem[] = [];
  let waiting: ((item: QueueItem) => void) | null = null;

  function push(item: QueueItem): void {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(item);
    } else {
      queue.push(item);
    }
  }

  subscriber.on('message', (_ch: string, raw: string) => {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.runId && parsed.runId !== runId) return;
      const metadata = (parsed.metadata as Record<string, unknown> | null) ?? null;
      const type = parsed.type as string;
      if (type === 'tool_call') {
        const toolName = metadata?.toolName as string | undefined;
        if (toolName === 'write_strategic_path') {
          // Fast path: the tool's input IS the StrategicPath. If the
          // agent emitted a strictly-schema-valid payload we can yield
          // without a DB round-trip.
          const input = metadata?.input;
          const v = strategicPathSchema.safeParse(input);
          if (v.success) {
            push({ type: 'strategic_done', path: v.data });
            push({ type: '__done' });
            return;
          }
          // Validation failed — log the specific issues, but don't bail.
          // The tool_result below is the source of truth: if the tool
          // itself persisted the row (even with a looser coerce path),
          // we'll pick it up via the DB fallback on tool_result success.
          log.warn(
            `write_strategic_path tool_call input failed schema validation (will fall back to DB on tool_result): ${v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          );
        }
      }
      if (type === 'tool_result') {
        const toolName = metadata?.toolName as string | undefined;
        const isError = metadata?.isError === true;
        if (toolName === 'write_strategic_path' && !isError) {
          // Tool succeeded (INSERT or UPDATE landed). Pull the path
          // back out of the DB by pathId so the UI gets a
          // canonical-from-storage payload rather than the agent's
          // possibly-looser tool_call input. Covers the case where
          // tool_call input was rejected by our strict schema but the
          // tool coerced + persisted a valid-enough row.
          const pathId = parsePathIdFromToolResult(parsed.content);
          if (pathId) {
            loadPathAndPush(pathId, push).catch((err) => {
              log.warn(
                `strategic_paths lookup for pathId=${pathId} failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              push({
                type: 'error',
                error: 'write_strategic_path succeeded but DB lookup failed',
              });
              push({ type: '__done' });
            });
            return;
          }
        }
      }
      if (type === 'error') {
        const message = (parsed.content as string | null) ?? 'team-run error';
        push({ type: 'error', error: message });
        push({ type: '__done' });
        return;
      }
      if (type === 'completion') {
        // Team run completed without a write_strategic_path emission —
        // surface as an error for the UI, which expects a strategic path.
        push({
          type: 'error',
          error: 'team-run completed without a strategic path',
        });
        push({ type: '__done' });
        return;
      }
    } catch (err) {
      log.warn(
        `subscribeToStrategicPathEvents: malformed payload: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });

  try {
    await subscriber.subscribe(channel);
  } catch (err) {
    push({
      type: 'error',
      error: `redis subscribe failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    push({ type: '__done' });
  }

  const deadline = Date.now() + timeoutMs;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let next: QueueItem;
      if (queue.length > 0) {
        next = queue.shift()!;
      } else {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          yield { type: 'error', error: 'team-run timed out' };
          return;
        }
        next = await new Promise<QueueItem>((resolve) => {
          waiting = resolve;
          setTimeout(() => {
            if (waiting === resolve) {
              waiting = null;
              resolve({ type: '__done' });
            }
          }, remaining);
        });
      }
      if (next.type === '__done') return;
      yield next;
    }
  } finally {
    try {
      await subscriber.unsubscribe();
    } catch {
      // Best-effort; nothing to propagate.
    }
    subscriber.disconnect();
  }
}
