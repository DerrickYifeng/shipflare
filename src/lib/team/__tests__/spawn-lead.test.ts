import { describe, it, expect, vi } from 'vitest';
import { ensureLeadAgentRun } from '@/lib/team/spawn-lead';

type InsertSpy = ReturnType<typeof vi.fn<(vals: unknown) => void>>;

interface FakeDbOptions {
  existing?: { id: string } | null;
  leadMember?: { id: string } | null;
  insertSpy?: InsertSpy;
}

function makeDb(opts: FakeDbOptions = {}) {
  const insertSpy = opts.insertSpy ?? vi.fn();
  // Two select calls happen: first for agent_runs, second for team_members.
  // Use a counter to return the right shape per call.
  let selectCallIndex = 0;
  const leadMember = opts.leadMember === undefined
    ? { id: 'lead-member-1' }
    : opts.leadMember;
  return {
    select: vi.fn(() => {
      const callIndex = selectCallIndex++;
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              if (callIndex === 0) {
                // agent_runs lookup
                return opts.existing ? [opts.existing] : [];
              }
              // team_members lookup
              return leadMember ? [leadMember] : [];
            }),
          })),
        })),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn(async (vals: unknown) => {
        insertSpy(vals);
        return [{ id: (vals as { id: string }).id }];
      }),
    })),
  };
}

describe('ensureLeadAgentRun', () => {
  it('returns existing leadAgentId when present', async () => {
    const db = makeDb({ existing: { id: 'existing-lead-1' } });
    const result = await ensureLeadAgentRun('team-1', db as never);
    expect(result.agentId).toBe('existing-lead-1');
  });

  it('creates new lead row when absent', async () => {
    const insertSpy = vi.fn();
    const db = makeDb({ existing: null, insertSpy });
    const result = await ensureLeadAgentRun('team-1', db as never);
    expect(result.agentId).toBeTruthy();
    expect(insertSpy).toHaveBeenCalledOnce();
    const inserted = insertSpy.mock.calls[0][0] as {
      teamId: string;
      status: string;
      parentAgentId: string | null;
      agentDefName: string;
      memberId: string;
    };
    expect(inserted.teamId).toBe('team-1');
    expect(inserted.status).toBe('sleeping');
    expect(inserted.parentAgentId).toBeNull();
    expect(inserted.agentDefName).toBe('coordinator');
    expect(inserted.memberId).toBe('lead-member-1');
  });

  it('idempotent — concurrent calls return same agentId', async () => {
    let cached: { id: string } | null = null;
    const insertSpy = vi.fn();
    let selectCallIndex = 0;
    const db = {
      select: vi.fn(() => {
        // Each call to select() may be either the agent_runs lookup
        // or the team_members lookup. We alternate based on call index
        // within a single ensureLeadAgentRun invocation:
        // call 0: agent_runs, call 1: team_members,
        // call 2: agent_runs, call 3: team_members, ...
        const callIndex = selectCallIndex++;
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => {
                // Even indices are agent_runs lookup; odd are team_members.
                if (callIndex % 2 === 0) {
                  return cached ? [cached] : [];
                }
                return [{ id: 'lead-member-1' }];
              }),
            })),
          })),
        };
      }),
      insert: vi.fn(() => ({
        values: vi.fn(async (vals: unknown) => {
          const v = vals as { id: string };
          cached = { id: v.id };
          insertSpy(vals);
          return [cached];
        }),
      })),
    };
    const r1 = await ensureLeadAgentRun('team-1', db as never);
    const r2 = await ensureLeadAgentRun('team-1', db as never);
    expect(r1.agentId).toBe(r2.agentId);
    expect(insertSpy).toHaveBeenCalledOnce();
  });

  it('throws when team has no coordinator member', async () => {
    const db = makeDb({ existing: null, leadMember: null });
    await expect(
      ensureLeadAgentRun('team-no-coord', db as never),
    ).rejects.toThrow(/coordinator/);
  });
});
