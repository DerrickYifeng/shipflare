// UI-B Task 11 — cancelTeammate helper unit tests.
//
// Verifies the I/O leaf:
//   - throws when the agent_runs row does not exist
//   - inserts a shutdown_request row stamped with the target's teamId
//   - wakes the target by agentId

import { describe, it, expect, vi, beforeEach } from 'vitest';

const wakeMock = vi.hoisted(() => vi.fn());
vi.mock('@/workers/processors/lib/wake', () => ({
  wake: wakeMock,
}));

import { cancelTeammate } from '@/lib/team/cancel-teammate';

type InsertSpy = ReturnType<typeof vi.fn<(vals: unknown) => void>>;

interface FakeDbOptions {
  target?: { teamId: string; memberId: string } | null;
  insertSpy?: InsertSpy;
}

function makeDb(opts: FakeDbOptions = {}) {
  const insertSpy = opts.insertSpy ?? vi.fn();
  const target = opts.target === undefined
    ? { teamId: 'team-1', memberId: 'member-1' }
    : opts.target;
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (target ? [target] : [])),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (vals: unknown) => {
        insertSpy(vals);
        return [vals];
      }),
    })),
  };
}

beforeEach(() => {
  wakeMock.mockReset();
  wakeMock.mockResolvedValue(undefined);
});

describe('cancelTeammate', () => {
  it('throws when agent_runs row does not exist', async () => {
    const db = makeDb({ target: null });
    await expect(
      cancelTeammate('missing-agent', db as never),
    ).rejects.toThrow(/missing-agent not found/);
  });

  it('does NOT wake when the target row is missing', async () => {
    const db = makeDb({ target: null });
    await expect(
      cancelTeammate('missing-agent', db as never),
    ).rejects.toThrow();
    expect(wakeMock).not.toHaveBeenCalled();
  });

  it('inserts a shutdown_request stamped with the target teamId + memberId', async () => {
    const insertSpy = vi.fn();
    const db = makeDb({
      target: { teamId: 'team-42', memberId: 'member-99' },
      insertSpy,
    });

    await cancelTeammate('agent-7', db as never);

    expect(insertSpy).toHaveBeenCalledOnce();
    const inserted = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.teamId).toBe('team-42');
    expect(inserted.toMemberId).toBe('member-99');
    expect(inserted.toAgentId).toBe('agent-7');
    expect(inserted.fromMemberId).toBeNull();
    expect(inserted.type).toBe('user_prompt');
    expect(inserted.messageType).toBe('shutdown_request');
    expect(inserted.summary).toBe('cancel');
    expect(typeof inserted.content).toBe('string');
  });

  it('wakes the target agent by agentId after the insert', async () => {
    const db = makeDb({
      target: { teamId: 'team-1', memberId: 'member-1' },
    });
    await cancelTeammate('agent-xyz', db as never);
    expect(wakeMock).toHaveBeenCalledOnce();
    expect(wakeMock).toHaveBeenCalledWith('agent-xyz');
  });
});
