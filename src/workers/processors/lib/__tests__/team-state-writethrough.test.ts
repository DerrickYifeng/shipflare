import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TeamStatePatch } from '@/lib/team/team-state-cache';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
//
// Mock the Redis client + the underlying writeTeamStateField helper so we
// can assert the writethrough wrapper passes the right patch shapes
// without needing a live Redis instance. We also assert the wrappers
// degrade gracefully when writeTeamStateField throws.

const writeTeamStateFieldMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => undefined),
);
vi.mock('@/lib/team/team-state-cache', () => ({
  writeTeamStateField: writeTeamStateFieldMock,
}));

const sentinelRedis = { __sentinel: 'kv-client' } as const;
vi.mock('@/lib/redis', () => ({
  getKeyValueClient: vi.fn(() => sentinelRedis),
}));

import {
  cacheLeadStatus,
  cacheTeammateSpawn,
  cacheTeammateStatus,
} from '@/workers/processors/lib/team-state-writethrough';

const FIXED_NOW = new Date('2026-05-02T10:00:00.000Z');
const TEAM_ID = 'team-1';

beforeEach(() => {
  writeTeamStateFieldMock.mockReset();
  writeTeamStateFieldMock.mockImplementation(async () => undefined);
});

// ---------------------------------------------------------------------------
// cacheLeadStatus
// ---------------------------------------------------------------------------

describe('cacheLeadStatus', () => {
  it('writes the lead patch with status, agentId, and ISO timestamp', async () => {
    await cacheLeadStatus(TEAM_ID, 'lead-1', 'running', FIXED_NOW);

    expect(writeTeamStateFieldMock).toHaveBeenCalledOnce();
    const [teamId, patch, redis] = writeTeamStateFieldMock.mock.calls[0] as unknown as [
      string,
      TeamStatePatch,
      unknown,
    ];
    expect(teamId).toBe(TEAM_ID);
    expect(patch).toEqual({
      leadStatus: 'running',
      leadAgentId: 'lead-1',
      leadLastActiveAt: FIXED_NOW.toISOString(),
    });
    expect(redis).toBe(sentinelRedis);
  });

  it('supports the sleeping status for the lead-back-to-idle transition', async () => {
    await cacheLeadStatus(TEAM_ID, 'lead-1', 'sleeping', FIXED_NOW);

    const patch = writeTeamStateFieldMock.mock.calls[0][1] as TeamStatePatch;
    expect(patch.leadStatus).toBe('sleeping');
  });

  it('does not throw when writeTeamStateField fails (graceful degradation)', async () => {
    writeTeamStateFieldMock.mockRejectedValueOnce(new Error('redis offline'));
    await expect(
      cacheLeadStatus(TEAM_ID, 'lead-1', 'running', FIXED_NOW),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cacheTeammateStatus — non-terminal
// ---------------------------------------------------------------------------

describe('cacheTeammateStatus — non-terminal', () => {
  it('writes a teammateUpdate patch for "running"', async () => {
    await cacheTeammateStatus(TEAM_ID, 'tm-1', 'running', FIXED_NOW);

    const [, patch] = writeTeamStateFieldMock.mock.calls[0] as unknown as [
      string,
      TeamStatePatch,
    ];
    expect(patch).toEqual({
      teammateUpdate: {
        agentId: 'tm-1',
        status: 'running',
        lastActiveAt: FIXED_NOW.toISOString(),
        sleepUntil: null,
      },
    });
  });

  it('forwards sleepUntil for the sleeping status', async () => {
    const wakeAt = new Date('2026-05-02T10:30:00.000Z');
    await cacheTeammateStatus(TEAM_ID, 'tm-1', 'sleeping', FIXED_NOW, wakeAt);

    const [, patch] = writeTeamStateFieldMock.mock.calls[0] as unknown as [
      string,
      TeamStatePatch,
    ];
    expect(patch.teammateUpdate?.sleepUntil).toBe(wakeAt.toISOString());
  });

  it('clears sleepUntil when set to null', async () => {
    await cacheTeammateStatus(TEAM_ID, 'tm-1', 'resuming', FIXED_NOW, null);

    const [, patch] = writeTeamStateFieldMock.mock.calls[0] as unknown as [
      string,
      TeamStatePatch,
    ];
    expect(patch.teammateUpdate?.sleepUntil).toBeNull();
  });

  it('handles the queued status', async () => {
    await cacheTeammateStatus(TEAM_ID, 'tm-1', 'queued', FIXED_NOW);

    const [, patch] = writeTeamStateFieldMock.mock.calls[0] as unknown as [
      string,
      TeamStatePatch,
    ];
    expect(patch.teammateUpdate?.status).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// cacheTeammateStatus — terminal
// ---------------------------------------------------------------------------

describe('cacheTeammateStatus — terminal', () => {
  it.each(['completed', 'failed', 'killed'] as const)(
    'writes teammateRemove for status=%s',
    async (status) => {
      await cacheTeammateStatus(TEAM_ID, 'tm-1', status, FIXED_NOW);

      expect(writeTeamStateFieldMock).toHaveBeenCalledOnce();
      const [, patch] = writeTeamStateFieldMock.mock.calls[0] as unknown as [
      string,
      TeamStatePatch,
    ];
      expect(patch).toEqual({ teammateRemove: 'tm-1' });
      // No teammateUpdate or other fields on a terminal patch.
      expect(patch.teammateUpdate).toBeUndefined();
    },
  );

  it('does not throw when writeTeamStateField fails on a terminal patch', async () => {
    writeTeamStateFieldMock.mockRejectedValueOnce(new Error('redis offline'));
    await expect(
      cacheTeammateStatus(TEAM_ID, 'tm-1', 'completed', FIXED_NOW),
    ).resolves.toBeUndefined();
  });

  it('does not throw when writeTeamStateField fails on a non-terminal patch', async () => {
    writeTeamStateFieldMock.mockRejectedValueOnce(new Error('redis offline'));
    await expect(
      cacheTeammateStatus(TEAM_ID, 'tm-1', 'running', FIXED_NOW),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cacheTeammateSpawn
// ---------------------------------------------------------------------------

describe('cacheTeammateSpawn', () => {
  it('writes a teammateAdd patch with the full TeammateEntry shape', async () => {
    await cacheTeammateSpawn(TEAM_ID, {
      agentId: 'tm-new',
      memberId: 'mem-new',
      agentDefName: 'reply-author',
      parentAgentId: 'lead-1',
      status: 'queued',
      lastActiveAt: FIXED_NOW,
      displayName: 'Sam',
    });

    expect(writeTeamStateFieldMock).toHaveBeenCalledOnce();
    const [teamId, patch, redis] = writeTeamStateFieldMock.mock.calls[0] as unknown as [
      string,
      TeamStatePatch,
      unknown,
    ];
    expect(teamId).toBe(TEAM_ID);
    expect(patch).toEqual({
      teammateAdd: {
        agentId: 'tm-new',
        memberId: 'mem-new',
        agentDefName: 'reply-author',
        parentAgentId: 'lead-1',
        status: 'queued',
        lastActiveAt: FIXED_NOW.toISOString(),
        sleepUntil: null,
        displayName: 'Sam',
      },
    });
    expect(redis).toBe(sentinelRedis);
  });

  it('accepts a null parentAgentId (top-level teammate)', async () => {
    await cacheTeammateSpawn(TEAM_ID, {
      agentId: 'tm-new',
      memberId: 'mem-new',
      agentDefName: 'reply-author',
      parentAgentId: null,
      status: 'queued',
      lastActiveAt: FIXED_NOW,
      displayName: 'Sam',
    });

    const [, patch] = writeTeamStateFieldMock.mock.calls[0] as unknown as [
      string,
      TeamStatePatch,
    ];
    expect(patch.teammateAdd?.parentAgentId).toBeNull();
  });

  it('does not throw when writeTeamStateField fails (graceful degradation)', async () => {
    writeTeamStateFieldMock.mockRejectedValueOnce(new Error('redis offline'));
    await expect(
      cacheTeammateSpawn(TEAM_ID, {
        agentId: 'tm-new',
        memberId: 'mem-new',
        agentDefName: 'reply-author',
        parentAgentId: 'lead-1',
        status: 'queued',
        lastActiveAt: FIXED_NOW,
        displayName: 'Sam',
      }),
    ).resolves.toBeUndefined();
  });
});
