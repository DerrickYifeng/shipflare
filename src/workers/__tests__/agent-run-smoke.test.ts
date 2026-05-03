// Production smoke test for the agent-run lead path. This catches the two
// classes of regression that escaped per-task review gauntlets in the
// fixes at:
//
//   - afc6f11 — `Agent "coordinator" declares unknown tool(s): Task,
//     SendMessage` because the worker process never imported
//     `@/tools/registry-team` and the deferred tool registration that
//     wires Task / SendMessage / Skill / TaskStop / Sleep into the
//     central registry never ran. Caught here by exercising the same
//     `buildAgentConfigFromDefinition(coordinator)` call the
//     agent-run worker makes when it picks up the lead.
//
//   - d49f1ee — `tools.7.custom.input_schema.type: Field required`
//     because `SendMessageInputSchema`'s
//     `z.preprocess(z.discriminatedUnion(...))` shape made
//     `zod-to-json-schema` emit a top-level `{ anyOf: [...] }` with no
//     `type` field, and `toAnthropicTool` did not inject one. Caught
//     here by serializing every concrete tool in each production
//     agent's resolved tool config and asserting `input_schema.type
//     === 'object'`.
//
// Both bugs slipped through because no single test exercised the
// end-to-end "boot worker → resolve agent's tool config → serialize
// for Anthropic API request" path. This file is that test.
//
// Worker-boot surrogate: importing `@/workers/index` would be the
// most-faithful boot reproduction, but it side-effects BullMQ Worker
// instances that connect to Redis and schedule cron repeats — too
// heavy for a unit test process. Instead we import the same
// side-effect module the worker pulls (`@/tools/registry-team`) and
// document that as the surrogate. If the worker ever stops importing
// registry-team transitively or directly, this test stops simulating
// the production boot path; the comment block in `src/workers/index.ts`
// flags the import as critical and points at this test for context.

// Worker-boot surrogate — see header comment.
import '@/tools/registry-team';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import { loadAgent } from '@/tools/AgentTool/loader';
import { buildAgentConfigFromDefinition } from '@/tools/AgentTool/spawn';
import { toAnthropicTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';

// UI-D Task 3 — write-through smoke test below relies on a mocked
// `getKeyValueClient` so we don't need a live Redis. The mock is hoisted
// so it's installed before any module that imports `@/lib/redis` is
// evaluated. Other tests in this file do not exercise the cache path,
// so the mock is inert for them.
const fakeRedisStore = vi.hoisted(() => new Map<string, string>());
const fakeRedis = vi.hoisted(() => ({
  store: fakeRedisStore,
  get: vi.fn(async (key: string) => fakeRedisStore.get(key) ?? null),
  setex: vi.fn(async (key: string, _ttl: number, value: string) => {
    fakeRedisStore.set(key, value);
    return 'OK';
  }),
  del: vi.fn(async (key: string) => {
    const had = fakeRedisStore.has(key);
    fakeRedisStore.delete(key);
    return had ? 1 : 0;
  }),
}));
vi.mock('@/lib/redis', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/redis')>();
  return {
    ...actual,
    getKeyValueClient: () => fakeRedis,
  };
});

// `ToolDefinition<TInput, TOutput>` is invariant in TInput / TOutput,
// so a concrete tool isn't assignable to the
// `ToolDefinition<unknown, unknown>` slot `toAnthropicTool` accepts.
// The helper only reads `name`, `description`, and `inputSchema`, so
// the cast is structurally sound — we just suppress the variance check
// at the boundary. (Same pattern as
// `tool-system-anthropic-conversion.test.ts`.)
const asAnyTool = <I, O>(
  t: ToolDefinition<I, O>,
): ToolDefinition<unknown, unknown> =>
  t as unknown as ToolDefinition<unknown, unknown>;

const AGENTS_DIR = path.resolve(__dirname, '../../tools/AgentTool/agents');

const PRODUCTION_AGENTS = [
  'coordinator',
  'content-manager',
  'content-planner',
  'discovery-agent',
] as const;

describe('agent-run smoke — production agents resolve + serialize cleanly', () => {
  for (const agentName of PRODUCTION_AGENTS) {
    describe(agentName, () => {
      it('AGENT.md loads', async () => {
        const def = await loadAgent(path.join(AGENTS_DIR, agentName));
        expect(def.name).toBe(agentName);
      });

      it('buildAgentConfigFromDefinition resolves all declared tools (catches missing registry imports)', async () => {
        const def = await loadAgent(path.join(AGENTS_DIR, agentName));
        // This is the call that throws
        // `Agent "coordinator" declares unknown tool(s): Task, SendMessage`
        // when registry-team isn't imported (regression afc6f11).
        expect(() => buildAgentConfigFromDefinition(def)).not.toThrow();
      });

      it("every resolved tool serializes to a valid Anthropic input_schema with type: 'object' (catches Zod->JSON-schema regressions)", async () => {
        const def = await loadAgent(path.join(AGENTS_DIR, agentName));
        const config = buildAgentConfigFromDefinition(def);

        // Assert one tool at a time so a failure prints which tool's
        // schema is bad — diagnostic for future regressions in the
        // same class as d49f1ee (preprocess + discriminatedUnion).
        for (const tool of config.tools) {
          const apiTool = toAnthropicTool(asAnyTool(tool));
          expect(
            apiTool.input_schema.type,
            `tool "${tool.name}" must serialize with input_schema.type === 'object'`,
          ).toBe('object');
        }
      });

      it('no resolved tool emits a top-level anyOf/oneOf/allOf in input_schema (Anthropic rejects these)', async () => {
        // Anthropic's tool input_schema grammar disallows anyOf/oneOf/allOf
        // at the top level even when `type: 'object'` is also present
        // (the bug d49f1ee tried — and failed — to fix). The flatten
        // pass in `toAnthropicTool` collapses any top-level union into a
        // single permissive object schema; this assertion guards that
        // every concrete production tool comes through cleanly.
        const def = await loadAgent(path.join(AGENTS_DIR, agentName));
        const config = buildAgentConfigFromDefinition(def);

        for (const tool of config.tools) {
          const apiTool = toAnthropicTool(asAnyTool(tool));
          const schema = apiTool.input_schema as Record<string, unknown>;
          expect(
            schema,
            `tool "${tool.name}" must not emit top-level anyOf`,
          ).not.toHaveProperty('anyOf');
          expect(
            schema,
            `tool "${tool.name}" must not emit top-level oneOf`,
          ).not.toHaveProperty('oneOf');
          expect(
            schema,
            `tool "${tool.name}" must not emit top-level allOf`,
          ).not.toHaveProperty('allOf');
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// UI-D Task 3 — team-state cache write-through smoke
// ---------------------------------------------------------------------------
//
// The cache module unit tests (src/lib/team/__tests__/team-state-cache.test.ts)
// and the writethrough wrapper tests
// (src/workers/processors/lib/__tests__/team-state-writethrough.test.ts)
// each cover one half of the contract in isolation. This smoke test
// stitches them together end-to-end against the same fake Redis: the
// writethrough helpers (called from agent-run worker hot paths in
// production) populate the cache, and `getTeamState` reads back what
// they wrote. If either side drifts (key shape, JSON shape, patch
// merge semantics) this test fails.
//
// We do NOT exercise the DB fallback path here — that's covered by the
// cache module tests. We only verify the wholly-cache-resident
// write-then-read round trip.

import {
  cacheLeadStatus,
  cacheTeammateSpawn,
  cacheTeammateStatus,
} from '@/workers/processors/lib/team-state-writethrough';
import {
  getTeamState,
  teamStateKey,
  type TeamState,
} from '@/lib/team/team-state-cache';

const SMOKE_TEAM_ID = 'team-smoke-uid-d';
const SMOKE_LEAD_AGENT_ID = 'lead-smoke-1';
const SMOKE_TEAMMATE_AGENT_ID = 'tm-smoke-1';
const SMOKE_TS = new Date('2026-05-03T00:00:00.000Z');

function seedCache(state: TeamState): void {
  fakeRedisStore.set(teamStateKey(SMOKE_TEAM_ID), JSON.stringify(state));
}

function emptyState(): TeamState {
  return {
    leadStatus: null,
    leadAgentId: null,
    leadLastActiveAt: null,
    teammates: [],
    lastUpdatedAt: SMOKE_TS.toISOString(),
  };
}

describe('UI-D state cache smoke — write-through populates cache from helper calls', () => {
  beforeEach(() => {
    fakeRedisStore.clear();
    fakeRedis.get.mockClear();
    fakeRedis.setex.mockClear();
    fakeRedis.del.mockClear();
  });

  it('cacheLeadStatus → getTeamState reads back the patched lead fields', async () => {
    // Seed an empty snapshot so write-through has something to patch.
    // (writeTeamStateField is no-op on cache miss by design — see
    // src/lib/team/team-state-cache.ts comment block.)
    seedCache(emptyState());

    await cacheLeadStatus(
      SMOKE_TEAM_ID,
      SMOKE_LEAD_AGENT_ID,
      'running',
      SMOKE_TS,
    );

    // The DB arg is unused on a cache hit — pass an obvious sentinel so
    // any accidental DB touch in the read path would blow up loudly.
    const dbSentinel = {
      select: () => {
        throw new Error('UI-D smoke: DB should not be touched on cache hit');
      },
    } as unknown as Parameters<typeof getTeamState>[1];

    const state = await getTeamState(SMOKE_TEAM_ID, dbSentinel, fakeRedis);
    expect(state.leadStatus).toBe('running');
    expect(state.leadAgentId).toBe(SMOKE_LEAD_AGENT_ID);
    expect(state.leadLastActiveAt).toBe(SMOKE_TS.toISOString());
  });

  it('cacheTeammateSpawn appends a teammate that getTeamState surfaces', async () => {
    seedCache(emptyState());

    await cacheTeammateSpawn(SMOKE_TEAM_ID, {
      agentId: SMOKE_TEAMMATE_AGENT_ID,
      memberId: 'member-smoke-1',
      agentDefName: 'content-manager',
      parentAgentId: SMOKE_LEAD_AGENT_ID,
      status: 'queued',
      lastActiveAt: SMOKE_TS,
      displayName: 'Smoke Teammate',
    });

    const state = await getTeamState(
      SMOKE_TEAM_ID,
      // Same DB-touch tripwire as above.
      {
        select: () => {
          throw new Error('UI-D smoke: DB should not be touched on cache hit');
        },
      } as unknown as Parameters<typeof getTeamState>[1],
      fakeRedis,
    );
    expect(state.teammates).toHaveLength(1);
    expect(state.teammates[0]).toMatchObject({
      agentId: SMOKE_TEAMMATE_AGENT_ID,
      memberId: 'member-smoke-1',
      status: 'queued',
      displayName: 'Smoke Teammate',
    });
  });

  it('cacheTeammateStatus terminal removes the teammate from the cached roster', async () => {
    // Seed a snapshot with one live teammate, then mark it completed.
    seedCache({
      ...emptyState(),
      teammates: [
        {
          agentId: SMOKE_TEAMMATE_AGENT_ID,
          memberId: 'member-smoke-1',
          agentDefName: 'content-manager',
          parentAgentId: SMOKE_LEAD_AGENT_ID,
          status: 'running',
          lastActiveAt: SMOKE_TS.toISOString(),
          sleepUntil: null,
          displayName: 'Smoke Teammate',
        },
      ],
    });

    await cacheTeammateStatus(
      SMOKE_TEAM_ID,
      SMOKE_TEAMMATE_AGENT_ID,
      'completed',
      SMOKE_TS,
    );

    const state = await getTeamState(
      SMOKE_TEAM_ID,
      {
        select: () => {
          throw new Error('UI-D smoke: DB should not be touched on cache hit');
        },
      } as unknown as Parameters<typeof getTeamState>[1],
      fakeRedis,
    );
    expect(state.teammates).toHaveLength(0);
  });
});
