/**
 * publishToolProgress — single emit point for live "tool is doing X" updates.
 *
 * Wraps `publishUserEvent(userId, 'agents', ...)` in a typed `tool_progress`
 * envelope so the /today TacticalProgressCard can route by `toolName` to the
 * right UI section. UI decoration only — failures are caught, counted, and
 * logged but **never thrown**: a Redis hiccup must not crash the agent loop.
 */

import { randomUUID } from 'node:crypto';
import { publishUserEvent } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:sse:tool-progress');

export interface ToolProgressEvent {
  type: 'tool_progress';
  toolName: string;
  callId: string;
  message: string;
  metadata?: Record<string, unknown>;
  ts: number;
}

export interface PublishToolProgressArgs {
  userId: string;
  toolName: string;
  message: string;
  metadata?: Record<string, unknown>;
}

let droppedCount = 0;

export async function publishToolProgress(
  args: PublishToolProgressArgs,
): Promise<void> {
  const event: ToolProgressEvent = {
    type: 'tool_progress',
    toolName: args.toolName,
    callId: randomUUID(),
    message: args.message,
    ...(args.metadata ? { metadata: args.metadata } : {}),
    ts: Date.now(),
  };
  try {
    await publishUserEvent(
      args.userId,
      'agents',
      event as unknown as Record<string, unknown>,
    );
  } catch (err) {
    droppedCount += 1;
    log.warn(
      `dropped tool_progress event tool=${args.toolName} user=${args.userId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Test-only — reset the in-process dropped counter. */
export function __resetDroppedCounter(): void {
  droppedCount = 0;
}

/** Test-only / observability — current dropped count. */
export function __getDroppedCount(): number {
  return droppedCount;
}
