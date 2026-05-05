// UI-D Task 2 — write-through helpers for the Redis team state cache.
//
// Spec: docs/superpowers/plans/2026-05-02-ui-agent-teams-redesign.md §1.5
//
// Each helper is fire-and-forget: Redis errors are logged + swallowed so
// cache failures never break the caller's main flow. The DB write the
// helper *follows* is the source of truth — the worst case on Redis
// failure is one stale read until the 60s TTL safety net kicks in.
//
// Caller contract:
//   - Call the helper AFTER the DB write that produced the new state has
//     completed. The cache is a read-side optimization; if you call before
//     the write you race the next reader against the unwritten row.
//   - Pass the same `lastActiveAt` Date you wrote to the DB so the cached
//     timestamp matches the durable row.
//
// Helper inventory:
//   - cacheLeadStatus     — lead transitions (queued/running/resuming/sleeping/...)
//   - cacheTeammateStatus — teammate transitions; terminal status removes
//                           the row from the roster, non-terminal patches it
//   - cacheTeammateSpawn  — append a freshly-inserted agent_runs row (Task tool
//                           launchAsyncTeammate)

import {
  writeTeamStateField,
  type LeadStatus,
  type TeammateEntry,
  type TeammateStatus,
} from '@/lib/team/team-state-cache';
import { getKeyValueClient } from '@/lib/redis';
import { createLogger } from '@/lib/logger';

const log = createLogger('team-state-writethrough');

/** Statuses that cause the teammate to be REMOVED from the cached roster. */
const TERMINAL_TEAMMATE_STATUSES = new Set(['completed', 'failed', 'killed']);

/**
 * Persist the lead's status transition into the team-state cache.
 *
 * Use after every `agent_runs.status` UPDATE on the lead row (queued →
 * running, running → sleeping, sleeping → resuming, etc.). Unlike a
 * teammate, the lead is never "removed" from the cache — when the lead
 * finishes a turn it goes back to `'sleeping'`, not a terminal state.
 */
export async function cacheLeadStatus(
  teamId: string,
  leadAgentId: string,
  status: LeadStatus,
  lastActiveAt: Date,
): Promise<void> {
  try {
    await writeTeamStateField(
      teamId,
      {
        leadStatus: status,
        leadAgentId,
        leadLastActiveAt: lastActiveAt.toISOString(),
      },
      getKeyValueClient(),
    );
  } catch (err) {
    log.warn(
      `cacheLeadStatus failed (cache will repopulate from DB on next read) team=${teamId}: ${describeError(err)}`,
    );
  }
}

/**
 * Persist a teammate status transition into the team-state cache.
 *
 * - For NON-TERMINAL statuses (queued/running/sleeping/resuming) → patch
 *   the teammate row in place, preserving sibling teammates.
 * - For TERMINAL statuses (completed/failed/killed) → remove the row from
 *   the roster entirely. The cached snapshot only carries live teammates.
 *
 * The optional `sleepUntil` is plumbed through for the `sleeping` status;
 * pass `null` (or omit) to clear it.
 */
export async function cacheTeammateStatus(
  teamId: string,
  agentId: string,
  status: 'queued' | 'running' | 'sleeping' | 'resuming' | 'completed' | 'failed' | 'killed',
  lastActiveAt: Date,
  sleepUntil?: Date | null,
): Promise<void> {
  try {
    if (TERMINAL_TEAMMATE_STATUSES.has(status)) {
      await writeTeamStateField(
        teamId,
        { teammateRemove: agentId },
        getKeyValueClient(),
      );
      return;
    }
    await writeTeamStateField(
      teamId,
      {
        teammateUpdate: {
          agentId,
          status: status as TeammateStatus,
          lastActiveAt: lastActiveAt.toISOString(),
          sleepUntil: sleepUntil ? sleepUntil.toISOString() : null,
        },
      },
      getKeyValueClient(),
    );
  } catch (err) {
    log.warn(
      `cacheTeammateStatus failed team=${teamId} agent=${agentId}: ${describeError(err)}`,
    );
  }
}

export interface TeammateSpawnPayload {
  agentId: string;
  memberId: string;
  agentDefName: string;
  parentAgentId: string | null;
  /** Always 'queued' for a fresh spawn — the agent-run worker promotes
   *  to 'running' once it picks up the BullMQ job. */
  status: 'queued';
  lastActiveAt: Date;
  displayName: string;
}

/**
 * Append a freshly-spawned teammate to the cached roster.
 *
 * Use right after the Task tool's `launchAsyncTeammate` inserts the
 * `agent_runs` row + initial mailbox message. The teammate is in
 * `'queued'` state and `sleepUntil` is always null at spawn time.
 */
export async function cacheTeammateSpawn(
  teamId: string,
  teammate: TeammateSpawnPayload,
): Promise<void> {
  try {
    const entry: TeammateEntry = {
      agentId: teammate.agentId,
      memberId: teammate.memberId,
      agentDefName: teammate.agentDefName,
      parentAgentId: teammate.parentAgentId,
      status: teammate.status,
      lastActiveAt: teammate.lastActiveAt.toISOString(),
      sleepUntil: null,
      displayName: teammate.displayName,
    };
    await writeTeamStateField(
      teamId,
      { teammateAdd: entry },
      getKeyValueClient(),
    );
  } catch (err) {
    log.warn(
      `cacheTeammateSpawn failed team=${teamId} agent=${teammate.agentId}: ${describeError(err)}`,
    );
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
