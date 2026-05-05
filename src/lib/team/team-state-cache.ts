// UI-D Task 1 — Redis-first team state cache with DB fallback.
//
// Spec: docs/superpowers/plans/2026-05-02-ui-agent-teams-redesign.md §1.5
//
// Design notes:
// - The cache is an OPTIMIZATION, not the source of truth. Postgres is
//   authoritative; Redis is a 60s snapshot we keep coherent via
//   write-through helpers from the agent-run worker.
// - Read path: GET → on miss, full DB query (lead row + non-terminal
//   teammates) → SETEX → return.
// - Write path (`writeTeamStateField`): GET → if absent, no-op (the next
//   read repopulates from DB); if present, patch the in-memory shape and
//   SETEX it back. We deliberately avoid CAS / WATCH — the DB is the
//   source of truth, so any drift heals on the next miss / TTL expiry.
// - Failures (Redis offline, malformed JSON) are logged + swallowed: the
//   read path falls through to DB; the write path does nothing and the
//   next read repopulates.

import { and, asc, eq, inArray } from 'drizzle-orm';
import type IORedis from 'ioredis';
import { agentRuns, teamMembers } from '@/lib/db/schema';
import type { Database } from '@/lib/db';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:team-state-cache');

/** Per-team Redis key holding the JSON snapshot. */
export function teamStateKey(teamId: string): string {
  return `team:state:${teamId}`;
}

/** TTL safety net — write-through is the primary correctness mechanism. */
export const TEAM_STATE_TTL_SECONDS = 60;

/** AgentDefName for the lead row in `agent_runs`. */
const LEAD_AGENT_DEF_NAME = 'coordinator';

/** Statuses we keep in the live teammate roster. Terminal states are
 *  excluded — once a teammate completes/fails/is killed, write-through
 *  removes them from the cached array. */
const NON_TERMINAL_TEAMMATE_STATUSES = [
  'queued',
  'running',
  'sleeping',
  'resuming',
] as const;

export type LeadStatus =
  | 'sleeping'
  | 'queued'
  | 'running'
  | 'resuming'
  | 'completed'
  | 'failed'
  | 'killed';

export type TeammateStatus = (typeof NON_TERMINAL_TEAMMATE_STATUSES)[number];

export interface TeammateEntry {
  agentId: string;
  memberId: string;
  agentDefName: string;
  parentAgentId: string | null;
  /** Never terminal — terminal removes from list. */
  status: TeammateStatus;
  /** ISO timestamp. */
  lastActiveAt: string;
  /** ISO timestamp or null. */
  sleepUntil: string | null;
  displayName: string;
}

export interface TeamState {
  leadStatus: LeadStatus | null;
  leadAgentId: string | null;
  /** ISO timestamp or null. */
  leadLastActiveAt: string | null;
  teammates: TeammateEntry[];
  /** ISO timestamp — when the snapshot was assembled. */
  lastUpdatedAt: string;
}

// Only a tiny slice of the IORedis surface is required here. Typing it
// narrowly keeps the test doubles small and lets callers pass in any
// shimmed Redis (ioredis-mock, hand-rolled fake, ...).
export interface RedisLike {
  get(key: string): Promise<string | null>;
  setex(key: string, ttlSeconds: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

// Sanity check that the real ioredis client satisfies our narrow surface.
// (Compile-time only — the value is unused.)
type _IORedisShape = Pick<IORedis, 'get' | 'setex' | 'del'>;
const _redisCompat: (_: _IORedisShape) => RedisLike = (x) => x;
void _redisCompat;

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

/**
 * Read team state — Redis first with 60s TTL safety net, DB fallback on
 * miss / parse error / Redis error. On a successful DB fallback the
 * snapshot is written back to Redis so the next read is a hit.
 */
export async function getTeamState(
  teamId: string,
  db: Database,
  redis: RedisLike,
): Promise<TeamState> {
  const cached = await safeGet(redis, teamStateKey(teamId));
  if (cached) {
    return cached;
  }
  const fresh = await loadFromDb(teamId, db);
  // Best-effort populate. If Redis is down, the read still succeeds.
  await safeSetex(redis, teamStateKey(teamId), fresh);
  return fresh;
}

async function loadFromDb(
  teamId: string,
  db: Database,
): Promise<TeamState> {
  const leadRows = await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      lastActiveAt: agentRuns.lastActiveAt,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.teamId, teamId),
        eq(agentRuns.agentDefName, LEAD_AGENT_DEF_NAME),
      ),
    )
    .limit(1);

  const teammateRows = await db
    .select({
      agentId: agentRuns.id,
      memberId: agentRuns.memberId,
      agentDefName: agentRuns.agentDefName,
      parentAgentId: agentRuns.parentAgentId,
      status: agentRuns.status,
      lastActiveAt: agentRuns.lastActiveAt,
      sleepUntil: agentRuns.sleepUntil,
      displayName: teamMembers.displayName,
    })
    .from(agentRuns)
    .innerJoin(teamMembers, eq(agentRuns.memberId, teamMembers.id))
    .where(
      and(
        eq(agentRuns.teamId, teamId),
        inArray(agentRuns.status, [...NON_TERMINAL_TEAMMATE_STATUSES]),
      ),
    )
    .orderBy(asc(agentRuns.spawnedAt));

  const lead = leadRows[0] ?? null;
  // Lead is in agent_runs too — strip it from the teammate list so the
  // roster is "everyone except the team-lead".
  const teammates: TeammateEntry[] = teammateRows
    .filter((row) => row.agentId !== lead?.id)
    .map((row) => ({
      agentId: row.agentId,
      memberId: row.memberId,
      agentDefName: row.agentDefName,
      parentAgentId: row.parentAgentId,
      status: row.status as TeammateStatus,
      lastActiveAt: toIso(row.lastActiveAt) ?? new Date().toISOString(),
      sleepUntil: toIso(row.sleepUntil),
      displayName: row.displayName,
    }));

  return {
    leadStatus: (lead?.status as LeadStatus | undefined) ?? null,
    leadAgentId: lead?.id ?? null,
    leadLastActiveAt: toIso(lead?.lastActiveAt ?? null),
    teammates,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return value; // already a string (e.g. ISO from JSONB roundtrip)
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

export interface TeamStatePatch {
  leadStatus?: LeadStatus | null;
  leadAgentId?: string | null;
  leadLastActiveAt?: string | null;
  /** Patch a single teammate keyed by `agentId`. */
  teammateUpdate?: { agentId: string } & Partial<TeammateEntry>;
  /** Drop a teammate by `agentId`. */
  teammateRemove?: string;
  /** Append a new teammate (e.g. on Task tool spawn). */
  teammateAdd?: TeammateEntry;
}

/**
 * Partial update for write-through callers. Reads the current snapshot
 * from Redis, merges the patch, and writes it back with a refreshed TTL.
 *
 * Cache miss (no key) is a deliberate no-op — the next read will
 * repopulate from DB. Redis errors are logged + swallowed: the DB write
 * has already happened by the time write-through is called, so the worst
 * case is one stale read until TTL expires.
 */
export async function writeTeamStateField(
  teamId: string,
  patch: TeamStatePatch,
  redis: RedisLike,
): Promise<void> {
  const key = teamStateKey(teamId);
  const current = await safeGet(redis, key);
  if (!current) {
    // Cache miss on write-through — next read will rebuild from DB.
    return;
  }
  const next = applyPatch(current, patch);
  await safeSetex(redis, key, next);
}

function applyPatch(state: TeamState, patch: TeamStatePatch): TeamState {
  let teammates = state.teammates;

  if (patch.teammateRemove) {
    teammates = teammates.filter((t) => t.agentId !== patch.teammateRemove);
  }

  if (patch.teammateUpdate) {
    const { agentId, ...rest } = patch.teammateUpdate;
    teammates = teammates.map((t) =>
      t.agentId === agentId ? { ...t, ...rest } : t,
    );
  }

  if (patch.teammateAdd) {
    teammates = [...teammates, patch.teammateAdd];
  }

  return {
    leadStatus:
      patch.leadStatus !== undefined ? patch.leadStatus : state.leadStatus,
    leadAgentId:
      patch.leadAgentId !== undefined ? patch.leadAgentId : state.leadAgentId,
    leadLastActiveAt:
      patch.leadLastActiveAt !== undefined
        ? patch.leadLastActiveAt
        : state.leadLastActiveAt,
    teammates,
    lastUpdatedAt: new Date().toISOString(),
  };
}

/**
 * Explicit eviction. Use when a write can't be expressed as a patch
 * (e.g. a multi-row DB operation) — next read rebuilds from DB.
 */
export async function invalidateTeamState(
  teamId: string,
  redis: RedisLike,
): Promise<void> {
  try {
    await redis.del(teamStateKey(teamId));
  } catch (err) {
    log.warn(
      `invalidateTeamState: redis del failed for team=${teamId}: ${describeError(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Redis I/O wrappers — every call is "soft" (errors degrade gracefully).
// ---------------------------------------------------------------------------

async function safeGet(
  redis: RedisLike,
  key: string,
): Promise<TeamState | null> {
  let raw: string | null;
  try {
    raw = await redis.get(key);
  } catch (err) {
    log.warn(`safeGet: redis get failed for key=${key}: ${describeError(err)}`);
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TeamState;
  } catch (err) {
    log.warn(
      `safeGet: malformed JSON in cache for key=${key}: ${describeError(err)}`,
    );
    return null;
  }
}

async function safeSetex(
  redis: RedisLike,
  key: string,
  value: TeamState,
): Promise<void> {
  try {
    await redis.setex(key, TEAM_STATE_TTL_SECONDS, JSON.stringify(value));
  } catch (err) {
    log.warn(`safeSetex: redis setex failed for key=${key}: ${describeError(err)}`);
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
