// Regression test — peer-DM shadow MUST NOT wake the lead.
//
// CLAUDE.md invariant (Agent Teams Architecture, item 3):
//   "Peer-DM shadow MUST NOT call wake(). With D3, the lead no longer
//   polls — it only acts on natural wakes (founder message, child
//   completion, sleep expiry). Peer-DM visibility is INTENDED to be
//   delayed until the next natural wake (this is the design)."
//
// This file is a focused regression guard for that invariant. The
// broader behavioural coverage lives in `peer-dm-shadow.test.ts`; here
// we belt-and-braces the two routes someone could use to bypass the
// invariant in the future:
//   1. Direct `wake()` call.
//   2. Bypassing the `wake()` helper and calling `enqueueAgentRun()`
//      directly.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock wake BEFORE importing the SUT — module-level imports cache.
vi.mock('@/workers/processors/lib/wake', () => ({
  wake: vi.fn(),
}));

// Also mock the underlying queue helper so we catch wake-bypass attempts.
vi.mock('@/lib/queue/agent-run', () => ({
  enqueueAgentRun: vi.fn(async () => {}),
}));

// Mock Redis publisher so SSE publish doesn't open a real connection.
vi.mock('@/lib/redis', () => ({
  getPubSubPublisher: () => ({ publish: vi.fn(async () => {}) }),
}));

import { insertPeerDmShadow } from '@/workers/processors/lib/peer-dm-shadow';
import { wake } from '@/workers/processors/lib/wake';
import { enqueueAgentRun } from '@/lib/queue/agent-run';

type InsertSpy = ReturnType<typeof vi.fn<(vals: unknown) => void>>;

function makeDbMock(opts: { insertSpy?: InsertSpy } = {}) {
  const insertSpy: InsertSpy =
    opts.insertSpy ?? vi.fn<(vals: unknown) => void>();
  return {
    insert: () => ({
      values: async (vals: unknown) => {
        insertSpy(vals);
      },
    }),
  };
}

describe('insertPeerDmShadow — no-wake invariant (Task D5 regression)', () => {
  beforeEach(() => {
    vi.mocked(wake).mockClear();
    vi.mocked(enqueueAgentRun).mockClear();
  });

  it('does NOT call wake() on the lead when a shadow is inserted', async () => {
    const insertSpy: InsertSpy = vi.fn<(vals: unknown) => void>();
    const db = makeDbMock({ insertSpy });

    await expect(
      insertPeerDmShadow({
        teamId: 'team-1',
        leadAgentId: 'lead-agent-id',
        fromName: 'member-1',
        toName: 'member-2',
        summary: 'sup',
        db: db as never,
      }),
    ).resolves.toBeUndefined();

    // Sanity: the shadow row WAS persisted (so the no-wake assertion
    // can't be vacuously true by virtue of the function early-returning).
    expect(insertSpy).toHaveBeenCalledOnce();
    // The contract under test:
    expect(wake).not.toHaveBeenCalled();
  });

  it('does NOT bypass wake() by calling enqueueAgentRun() directly', async () => {
    const db = makeDbMock();

    await insertPeerDmShadow({
      teamId: 'team-1',
      leadAgentId: 'lead-agent-id',
      fromName: 'member-1',
      toName: 'member-2',
      summary: 'sup',
      db: db as never,
    });

    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });

  it('does NOT call wake() in the leadAgentId=null short-circuit either', async () => {
    const db = makeDbMock();

    await insertPeerDmShadow({
      teamId: 'team-1',
      leadAgentId: null,
      fromName: 'member-1',
      toName: 'member-2',
      summary: 'sup',
      db: db as never,
    });

    expect(wake).not.toHaveBeenCalled();
    expect(enqueueAgentRun).not.toHaveBeenCalled();
  });
});
