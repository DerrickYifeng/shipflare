/**
 * Route-level test for Phase D Day 3 Task #9 — `/api/team/message` must
 * publish to the per-run inject channel when a coordinator is actively
 * running, and fall back to enqueuing a new team_run when none is.
 *
 * The worker-side consumption (runAgent's `injectMessages` callback
 * draining a FIFO) is covered by the team-run integration test; here
 * we assert the route does the right publish.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

let authUserId: string | null = 'user-1';
vi.mock('@/lib/auth', () => ({
  auth: async () => (authUserId ? { user: { id: authUserId } } : null),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

interface TeamRow {
  id: string;
  userId: string;
}
interface MemberRow {
  id: string;
  teamId: string;
  agentType: string;
}
interface RunRow {
  id: string;
  teamId: string;
  status: string;
}
interface MessageRow {
  id: string;
  runId: string | null;
  teamId: string;
  type: string;
  content: string | null;
}

const teamsTable: TeamRow[] = [];
const membersTable: MemberRow[] = [];
const runsTable: RunRow[] = [];
const messagesTable: MessageRow[] = [];

interface EqSentinel {
  __eq: { column: unknown; value: unknown };
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
      __eq: { column: col, value },
    }),
    and: (...clauses: Array<EqSentinel | AndSentinel>): AndSentinel => ({
      __and: clauses,
    }),
  };
});

function flatten(cond: EqSentinel | AndSentinel | undefined): unknown[] {
  if (!cond) return [];
  if ('__eq' in cond) return [cond.__eq.value];
  return cond.__and.flatMap((c) => flatten(c));
}

vi.mock('@/lib/db', async () => {
  const schema = await import('@/lib/db/schema');

  function rowsFor(table: unknown): unknown[] {
    if (table === schema.teams) return teamsTable;
    if (table === schema.teamMembers) return membersTable;
    if (table === schema.teamRuns) return runsTable;
    if (table === schema.teamMessages) return messagesTable;
    throw new Error('unknown table');
  }

  return {
    db: {
      select() {
        let table: unknown = null;
        let filter: EqSentinel | AndSentinel | undefined;
        const builder = {
          from(t: unknown) {
            table = t;
            return builder;
          },
          where(c: EqSentinel | AndSentinel) {
            filter = c;
            return builder;
          },
          limit(n: number) {
            const rows = rowsFor(table);
            const values = flatten(filter);
            const matches = rows.filter((row) => {
              const r = row as Record<string, unknown>;
              return values.every((v) =>
                [r.id, r.teamId, r.agentType, r.status].includes(v),
              );
            });
            return Promise.resolve(matches.slice(0, n));
          },
        };
        return builder;
      },
      insert(table: unknown) {
        return {
          values(row: Record<string, unknown>) {
            if (table === schema.teamMessages) {
              messagesTable.push(row as unknown as MessageRow);
            } else {
              throw new Error('unexpected insert table');
            }
            return Promise.resolve();
          },
        };
      },
    },
  };
});

// Capture publish calls to both channels.
const published: Array<{ channel: string; payload: string }> = [];
vi.mock('@/lib/redis', () => ({
  getPubSubPublisher: () => ({
    publish: async (channel: string, payload: string) => {
      published.push({ channel, payload });
      return 1;
    },
  }),
}));

// enqueueTeamRun not needed when there IS an active run, but importing the
// route loads it; stub to keep it inert for the "no active run" path.
vi.mock('@/lib/queue/team-run', () => ({
  enqueueTeamRun: vi.fn(async () => ({
    runId: 'newrun-123',
    traceId: 'trace-new',
    alreadyRunning: false,
  })),
}));

// ---------------------------------------------------------------------------
// Import route after mocks
// ---------------------------------------------------------------------------

import { POST } from '../route';
import { teamInjectChannel, teamMessagesChannel } from '@/tools/SendMessageTool';

beforeEach(() => {
  teamsTable.length = 0;
  membersTable.length = 0;
  runsTable.length = 0;
  messagesTable.length = 0;
  published.length = 0;
  authUserId = 'user-1';
});

function postRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/team/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/team/message — live injection', () => {
  it('publishes to the inject channel when a run is active', async () => {
    teamsTable.push({ id: 'team-x', userId: 'user-1' });
    runsTable.push({ id: 'run-x', teamId: 'team-x', status: 'running' });

    const res = await POST(
      postRequest({ teamId: 'team-x', message: 'pivot to X' }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      messageId: string;
      runId: string;
    };
    expect(json.runId).toBe('run-x');

    // Both the SSE channel AND the inject channel received a publish.
    const channels = published.map((p) => p.channel);
    expect(channels).toContain(teamMessagesChannel('team-x'));
    expect(channels).toContain(teamInjectChannel('team-x', 'run-x'));

    // The inject payload carries the message content for the worker
    // to push onto its FIFO.
    const injectEntry = published.find(
      (p) => p.channel === teamInjectChannel('team-x', 'run-x'),
    );
    expect(injectEntry).toBeDefined();
    const parsed = JSON.parse(injectEntry!.payload) as {
      content: string;
      messageId: string;
    };
    expect(parsed.content).toBe('pivot to X');
    expect(parsed.messageId).toBe(json.messageId);

    // Durable record still written.
    expect(messagesTable).toHaveLength(1);
    expect(messagesTable[0].content).toBe('pivot to X');
    expect(messagesTable[0].runId).toBe('run-x');
  });

  it('does NOT publish to the inject channel when no run is active', async () => {
    teamsTable.push({ id: 'team-y', userId: 'user-1' });
    membersTable.push({
      id: 'mem-coord-y',
      teamId: 'team-y',
      agentType: 'coordinator',
    });
    // No 'running' row.

    const res = await POST(
      postRequest({ teamId: 'team-y', message: 'start something' }),
    );
    expect(res.status).toBe(202);

    const injectChannels = published.filter((p) =>
      p.channel.startsWith('team:team-y:inject:'),
    );
    expect(injectChannels).toHaveLength(0);

    // New run is started (via enqueueTeamRun mock). The durable record
    // on team_messages carries a null runId because it was inserted
    // BEFORE the run was enqueued.
    expect(messagesTable).toHaveLength(1);
    expect(messagesTable[0].runId).toBeNull();
  });

  it('returns 401 when unauthenticated', async () => {
    authUserId = null;
    const res = await POST(
      postRequest({ teamId: 'team-z', message: 'nope' }),
    );
    expect(res.status).toBe(401);
  });
});
