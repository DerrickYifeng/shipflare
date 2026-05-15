// Phase B7 — AgentStatusBatcher unit tests.
//
// The batcher coalesces transient agent_runs status writes (queued →
// running → sleeping heartbeats) on a 500ms tick so a chatty multi-turn
// run produces ~one DB write per tick instead of one per transition.
//
// Critical properties:
//  - Last-write-wins per agentId (Map.set semantics)
//  - flushNow on an empty buffer is a no-op (no flush callback fired)
//  - dispose clears the interval AND flushes any pending entries
//  - Flush failures re-buffer entries so the next tick retries; if a
//    NEWER update lands during the failed flush, it survives the
//    re-buffer (newer-is-better)

import { describe, it, expect, vi } from 'vitest';
import {
  AgentStatusBatcher,
  type FlushPayload,
  type StatusUpdate,
} from '../agent-status-batcher';

function makeUpdate(partial: Partial<StatusUpdate> = {}): StatusUpdate {
  return {
    status: 'running',
    lastActiveAt: new Date('2026-05-12T00:00:00Z'),
    ...partial,
  };
}

describe('AgentStatusBatcher', () => {
  it('coalesces multiple updates for the same agent into one flush (last wins)', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const batcher = new AgentStatusBatcher({ flushIntervalMs: 50, flush });
    batcher.set('a-1', makeUpdate({ status: 'running' }));
    batcher.set('a-1', makeUpdate({ status: 'sleeping' }));
    await new Promise((r) => setTimeout(r, 80));
    expect(flush).toHaveBeenCalledTimes(1);
    const batch = flush.mock.calls[0][0] as FlushPayload[];
    expect(batch).toHaveLength(1);
    expect(batch[0].agentId).toBe('a-1');
    expect(batch[0].status).toBe('sleeping');
    batcher.dispose();
  });

  it('flushes multiple distinct agents in one batch', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const batcher = new AgentStatusBatcher({ flushIntervalMs: 50, flush });
    batcher.set('a-1', makeUpdate({ status: 'running' }));
    batcher.set('a-2', makeUpdate({ status: 'sleeping' }));
    batcher.set('a-3', makeUpdate({ status: 'resuming' }));
    await new Promise((r) => setTimeout(r, 80));
    expect(flush).toHaveBeenCalledTimes(1);
    const batch = flush.mock.calls[0][0] as FlushPayload[];
    expect(batch).toHaveLength(3);
    const byId = Object.fromEntries(batch.map((p) => [p.agentId, p.status]));
    expect(byId).toEqual({ 'a-1': 'running', 'a-2': 'sleeping', 'a-3': 'resuming' });
    batcher.dispose();
  });

  it('does not call flush when the buffer is empty', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const batcher = new AgentStatusBatcher({ flushIntervalMs: 30, flush });
    await new Promise((r) => setTimeout(r, 100)); // ~3 idle ticks
    expect(flush).not.toHaveBeenCalled();
    batcher.dispose();
  });

  it('dispose() flushes any pending entries synchronously', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const batcher = new AgentStatusBatcher({ flushIntervalMs: 10_000, flush });
    batcher.set('a-1', makeUpdate({ status: 'sleeping' }));
    // dispose() schedules a final flush; await one microtask + a beat so
    // the pending promise settles.
    batcher.dispose();
    await new Promise((r) => setTimeout(r, 10));
    expect(flush).toHaveBeenCalledTimes(1);
    const batch = flush.mock.calls[0][0] as FlushPayload[];
    expect(batch[0].agentId).toBe('a-1');
  });

  it('re-buffers entries when the flush callback rejects', async () => {
    let callCount = 0;
    const flush = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('db unreachable');
    });
    const batcher = new AgentStatusBatcher({ flushIntervalMs: 30, flush });
    batcher.set('a-1', makeUpdate({ status: 'running' }));
    // First tick fails; entry should re-buffer. Wait through a second tick.
    await new Promise((r) => setTimeout(r, 100));
    expect(flush).toHaveBeenCalledTimes(2);
    const secondBatch = flush.mock.calls[1][0] as FlushPayload[];
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0].agentId).toBe('a-1');
    batcher.dispose();
  });

  it('newer update during failed flush overwrites the re-buffered entry', async () => {
    const flushImpls: Array<(batch: FlushPayload[]) => Promise<void>> = [];
    const newerLanded = vi.fn();
    // Plan:
    //  1. Tick #1 — flush throws; re-buffer should preserve {status:'running'}
    //  2. Before tick #2 — caller writes a NEWER update {status:'sleeping'};
    //     Map.set must overwrite the re-buffered entry
    //  3. Tick #2 — flush succeeds with {status:'sleeping'}
    let landed = false;
    const flush = vi.fn().mockImplementation(async (batch: FlushPayload[]) => {
      flushImpls.push(async () => {});
      if (!landed) {
        landed = true;
        throw new Error('flake');
      }
      newerLanded(batch);
    });
    const batcher = new AgentStatusBatcher({ flushIntervalMs: 30, flush });
    batcher.set('a-1', makeUpdate({ status: 'running' }));
    // Wait through the first (failing) flush.
    await new Promise((r) => setTimeout(r, 50));
    // Now overwrite with a newer update before the next tick.
    batcher.set('a-1', makeUpdate({ status: 'sleeping' }));
    // Wait through the second (succeeding) flush.
    await new Promise((r) => setTimeout(r, 50));
    expect(newerLanded).toHaveBeenCalledOnce();
    const batch = newerLanded.mock.calls[0][0] as FlushPayload[];
    expect(batch[0].agentId).toBe('a-1');
    expect(batch[0].status).toBe('sleeping');
    batcher.dispose();
  });

  it('preserves all StatusUpdate fields through the flush callback', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const batcher = new AgentStatusBatcher({ flushIntervalMs: 30, flush });
    const update: StatusUpdate = {
      status: 'sleeping',
      lastActiveAt: new Date('2026-05-12T01:00:00Z'),
      sleepUntil: new Date('2026-05-12T02:00:00Z'),
      shutdownReason: null,
      totalTokens: 12345,
      toolUses: 7,
      bullmqJobId: 'job-xyz',
    };
    batcher.set('a-1', update);
    await new Promise((r) => setTimeout(r, 60));
    const batch = flush.mock.calls[0][0] as FlushPayload[];
    expect(batch[0]).toMatchObject({
      agentId: 'a-1',
      status: 'sleeping',
      sleepUntil: update.sleepUntil,
      totalTokens: 12345,
      toolUses: 7,
      bullmqJobId: 'job-xyz',
    });
    batcher.dispose();
  });

  // --------------------------------------------------------------------
  // invalidate() — drops a buffered entry without flushing (B7 race fix)
  // --------------------------------------------------------------------

  it('invalidate drops the buffered entry without flushing', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const batcher = new AgentStatusBatcher({ flushIntervalMs: 50, flush });
    batcher.set('a-1', makeUpdate({ status: 'running' }));
    batcher.invalidate('a-1');
    await new Promise((r) => setTimeout(r, 80));
    expect(flush).not.toHaveBeenCalled();
    await batcher.dispose();
  });

  it('invalidate is a no-op when no entry is buffered', () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const batcher = new AgentStatusBatcher({ flushIntervalMs: 50, flush });
    expect(() => batcher.invalidate('never-set')).not.toThrow();
    batcher.dispose();
  });

  it('invalidate prevents a stale transient from overwriting a sync terminal write (bug pattern)', async () => {
    // Simulates the C1 race:
    //   set('a-1', {status:'running'})  — transient, buffered
    //   <markFailed() would write 'failed' here synchronously>
    //   statusBatcher.invalidate('a-1')  — MUST happen before the sync write
    //   ...batcher tick fires later → MUST NOT flush a stale 'running'
    const flush = vi.fn().mockResolvedValue(undefined);
    const batcher = new AgentStatusBatcher({ flushIntervalMs: 30, flush });
    batcher.set('a-1', makeUpdate({ status: 'running' }));
    // (Pretend the markFailed sync write happens here — outside the batcher.)
    batcher.invalidate('a-1');
    // Wait through multiple ticks.
    await new Promise((r) => setTimeout(r, 120));
    expect(flush).not.toHaveBeenCalled();
    await batcher.dispose();
  });

  it('invalidate one agent does not affect other buffered agents', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const batcher = new AgentStatusBatcher({ flushIntervalMs: 40, flush });
    batcher.set('a-1', makeUpdate({ status: 'running' }));
    batcher.set('a-2', makeUpdate({ status: 'sleeping' }));
    batcher.invalidate('a-1');
    await new Promise((r) => setTimeout(r, 70));
    expect(flush).toHaveBeenCalledTimes(1);
    const batch = flush.mock.calls[0][0] as FlushPayload[];
    expect(batch).toHaveLength(1);
    expect(batch[0].agentId).toBe('a-2');
    await batcher.dispose();
  });

  // --------------------------------------------------------------------
  // dispose() — now async, awaits the final flush (I1)
  // --------------------------------------------------------------------

  it('dispose() awaits a slow final flush instead of returning early', async () => {
    let flushDone = false;
    const flush = vi.fn().mockImplementation(async () => {
      // Simulate a slow DB round-trip — longer than the old 200ms grace.
      await new Promise((r) => setTimeout(r, 80));
      flushDone = true;
    });
    const batcher = new AgentStatusBatcher({ flushIntervalMs: 10_000, flush });
    batcher.set('a-1', makeUpdate({ status: 'sleeping' }));
    await batcher.dispose();
    // The await on dispose() must not resolve until flush actually finished.
    expect(flushDone).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('dispose() is idempotent — second call resolves immediately without re-flushing', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const batcher = new AgentStatusBatcher({ flushIntervalMs: 10_000, flush });
    batcher.set('a-1', makeUpdate({ status: 'sleeping' }));
    await batcher.dispose();
    await batcher.dispose();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('dispose() swallows flush errors so the worker can still exit cleanly', async () => {
    const flush = vi
      .fn()
      .mockImplementation(async () => {
        throw new Error('db went down at shutdown');
      });
    const batcher = new AgentStatusBatcher({ flushIntervalMs: 10_000, flush });
    batcher.set('a-1', makeUpdate({ status: 'sleeping' }));
    // Must NOT reject — dispose's job is to give the process a clean exit.
    await expect(batcher.dispose()).resolves.toBeUndefined();
  });
});
