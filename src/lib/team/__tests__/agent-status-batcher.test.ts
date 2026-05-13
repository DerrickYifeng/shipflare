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
});
