/**
 * SendMessage tool unit tests.
 *
 * Strategy: inject a fake db + fake Redis publisher via ToolContext.get, so
 * we can assert both the INSERT and the PUBLISH happened without standing
 * up Postgres or Redis.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolContext } from '@/core/types';

// ---------------------------------------------------------------------------
// In-memory fixtures
// ---------------------------------------------------------------------------

interface MemberRow {
  id: string;
  teamId: string;
  displayName: string;
}

interface MessageRow {
  id: string;
  runId: string | null;
  teamId: string;
  fromMemberId: string | null;
  toMemberId: string | null;
  type: string;
  content: string | null;
}

const members: MemberRow[] = [];
const inserts: MessageRow[] = [];

// ---------------------------------------------------------------------------
// Fake drizzle query builders
// ---------------------------------------------------------------------------
//
// We only need to service exactly the two queries SendMessage issues:
//   (a) SELECT id FROM team_members WHERE id=? AND team_id=? LIMIT 1
//   (b) SELECT id FROM team_members WHERE display_name=? AND team_id=? LIMIT 2
//   (c) INSERT INTO team_messages (...)
//
// We intercept drizzle-orm's `eq` + `and` so they emit sentinel objects we
// can decode in the mock; the chainable builder then reads those sentinels.

interface EqSentinel {
  __eq: { column: string; value: unknown };
}
interface AndSentinel {
  __and: Array<EqSentinel | AndSentinel>;
}

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: unknown, value: unknown): EqSentinel => ({
      __eq: { column: String((col as { name?: string })?.name ?? col), value },
    }),
    and: (...clauses: Array<EqSentinel | AndSentinel>): AndSentinel => ({
      __and: clauses,
    }),
  };
});

function flattenConditions(
  cond: EqSentinel | AndSentinel | undefined,
): Array<{ column: string; value: unknown }> {
  if (!cond) return [];
  if ('__eq' in cond) return [cond.__eq];
  return cond.__and.flatMap((c) => flattenConditions(c));
}

interface DbTable {
  name: string;
}

function tableName(t: unknown): string {
  // Drizzle pg tables expose a Symbol.for('drizzle:Name'), but we don't need
  // strictness here — the fake db only distinguishes between team_members
  // (for selects) and team_messages (for inserts) via the caller sequence.
  return (t as DbTable)?.name ?? 'unknown';
}

function makeFakeDb() {
  return {
    select(_cols?: unknown) {
      let mode: 'members' | null = null;
      let filters: Array<{ column: string; value: unknown }> = [];
      const builder = {
        from(table: unknown) {
          // We only select from team_members in SendMessage.
          const name = tableName(table);
          if (name.includes('team_members') || true) {
            mode = 'members';
          }
          return builder;
        },
        where(cond: EqSentinel | AndSentinel) {
          filters = flattenConditions(cond);
          return builder;
        },
        limit(n: number): Promise<Array<{ id: string }>> {
          if (mode !== 'members') return Promise.resolve([]);
          // The drizzle column object varies in shape across versions — we
          // take a shape-agnostic approach: collect all filter values and
          // filter the in-memory members by "every filter matches at least
          // one of { id, teamId, displayName }". Works because SendMessage
          // only composes eq() across these three fields.
          const values = filters.map((f) => f.value);
          const matches = members.filter((m) =>
            values.every(
              (v) => v === m.id || v === m.teamId || v === m.displayName,
            ),
          );
          return Promise.resolve(matches.slice(0, n).map((m) => ({ id: m.id })));
        },
      };
      return builder;
    },
    insert(_table: unknown) {
      return {
        values(row: MessageRow) {
          inserts.push(row);
          return Promise.resolve();
        },
      };
    },
  };
}

const fakeDb = makeFakeDb();

// Fake Redis pubsub publisher recorder
const publishedRaw: Array<{ channel: string; message: string }> = [];
vi.mock('@/lib/redis', () => ({
  getPubSubPublisher: () => ({
    publish: async (channel: string, message: string) => {
      publishedRaw.push({ channel, message });
      return 1;
    },
  }),
}));

// We mock @/lib/db so the tool's default import path doesn't hit Postgres.
// The test always injects `db` via ctx.get, but the module still imports
// `db` top-level (which would trigger `postgres(...)` at import time).
vi.mock('@/lib/db', () => ({
  db: makeFakeDb(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

import {
  sendMessageTool,
  SEND_MESSAGE_TOOL_NAME,
  teamMessagesChannel,
} from '../SendMessageTool';

function makeCtx(
  deps: Record<string, unknown>,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  const ac = new AbortController();
  return {
    abortSignal: overrides.abortSignal ?? ac.signal,
    get<V>(key: string): V {
      if (key in deps) return deps[key] as V;
      throw new Error(`no dep ${key}`);
    },
  };
}

beforeEach(() => {
  members.length = 0;
  inserts.length = 0;
  publishedRaw.length = 0;
});

describe('SendMessage tool', () => {
  it('exports the canonical tool name', () => {
    expect(sendMessageTool.name).toBe(SEND_MESSAGE_TOOL_NAME);
    expect(SEND_MESSAGE_TOOL_NAME).toBe('SendMessage');
  });

  it('resolves a recipient by display_name and records + publishes the message', async () => {
    members.push({
      id: 'mem-alex',
      teamId: 'team-1',
      displayName: 'Alex',
    });

    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
      runId: 'run-1',
    });

    const result = await sendMessageTool.execute(
      { type: 'message', to: 'Alex', content: 'hi Alex' },
      ctx,
    );

    expect(result.delivered).toBe(true);
    expect(result.toMemberId).toBe('mem-alex');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].content).toBe('hi Alex');
    expect(inserts[0].fromMemberId).toBe('mem-sam');
    expect(inserts[0].toMemberId).toBe('mem-alex');
    expect(inserts[0].runId).toBe('run-1');
    expect(inserts[0].type).toBe('agent_text');

    expect(publishedRaw).toHaveLength(1);
    expect(publishedRaw[0].channel).toBe(teamMessagesChannel('team-1'));
    const payload = JSON.parse(publishedRaw[0].message);
    expect(payload.messageId).toBe(result.messageId);
    expect(payload.content).toBe('hi Alex');
  });

  it('errors when the display_name is not a team member', async () => {
    // No members seeded
    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
    });

    await expect(
      sendMessageTool.execute(
        { type: 'message', to: 'Ghost', content: 'hello?' },
        ctx,
      ),
    ).rejects.toThrow(/no team member named "Ghost"/);
    expect(inserts).toHaveLength(0);
    expect(publishedRaw).toHaveLength(0);
  });

  it('accepts a uuid-shaped `to` and resolves by id', async () => {
    const memberId = '11111111-2222-3333-4444-555555555555';
    members.push({ id: memberId, teamId: 'team-1', displayName: 'Alex' });

    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
    });

    const result = await sendMessageTool.execute(
      { type: 'message', to: memberId, content: 'hi' },
      ctx,
    );
    expect(result.toMemberId).toBe(memberId);
  });

  it('still returns success when Redis publish fails (DB insert is durable)', async () => {
    members.push({
      id: 'mem-alex',
      teamId: 'team-1',
      displayName: 'Alex',
    });
    // Swap the pubsub publisher to throw. vi.doMock would require a
    // re-import cycle; instead we reach into the module by re-mocking.
    const ctx = makeCtx({
      db: fakeDb,
      teamId: 'team-1',
      currentMemberId: 'mem-sam',
    });

    // Monkey-patch the recorded publisher to throw on next call.
    // (Fresh publishedRaw already cleared in beforeEach.)
    // The tool catches errors at publishToRedis and logs a warning; the
    // happy-path assertions cover the non-throwing path.
    //
    // To simulate failure, replace the mock implementation per-call.
    const redis = await import('@/lib/redis');
    const spy = vi
      .spyOn(redis, 'getPubSubPublisher')
      .mockImplementation(() => ({
        publish: async () => {
          throw new Error('redis down');
        },
      }) as unknown as ReturnType<typeof redis.getPubSubPublisher>);

    const result = await sendMessageTool.execute(
      { type: 'message', to: 'Alex', content: 'hi' },
      ctx,
    );
    expect(result.delivered).toBe(true);
    expect(inserts).toHaveLength(1);
    spy.mockRestore();
  });
});
