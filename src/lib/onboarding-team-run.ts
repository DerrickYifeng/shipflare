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

import { createPubSubSubscriber } from '@/lib/redis';
import { teamMessagesChannel } from '@/tools/SendMessageTool/SendMessageTool';
import { createLogger } from '@/lib/logger';
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
          // The tool's input IS the StrategicPath.
          const input = metadata?.input;
          const v = strategicPathSchema.safeParse(input);
          if (v.success) {
            push({ type: 'strategic_done', path: v.data });
            push({ type: '__done' });
            return;
          }
          log.warn(
            `write_strategic_path input failed schema validation: ${v.error.message}`,
          );
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
