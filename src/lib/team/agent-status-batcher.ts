// Phase B7 — AgentStatusBatcher.
//
// Coalesces transient `agent_runs` status writes (queued → running →
// sleeping heartbeats, lastActiveAt bumps, totalTokens / toolUses
// running totals) onto a fixed-interval flush tick. A chatty 20-turn
// run that transitions running ↔ sleeping ~30 times produces ~one DB
// write per 500ms tick instead of one per transition — net effect on
// pg: 5 writes for the same run.
//
// Last-write-wins per agentId: callers compute the LATEST cumulative
// value (not an increment) for monotonic fields like totalTokens and
// toolUses, so dropping intermediate states is fine — the DB just
// needs the latest snapshot.
//
// What this is NOT for:
//   - Terminal writes (status: 'completed' | 'failed' | 'killed').
//     Those happen as the worker exits; the setInterval can't fire if
//     the process dies, so callers MUST write them synchronously.
//   - Redis cache write-through. The flush callback is the right place
//     to do cache writes (so cache + DB stay aligned per batch); the
//     batcher itself is storage-agnostic.
//   - SSE pubs. The plan calls for SSE pubs to stay realtime — callers
//     publish immediately, then enqueue the durable write through the
//     batcher.
//
// Lifecycle: a single module-level batcher per worker process is the
// expected pattern. Wire `dispose()` into the worker's SIGTERM/SIGINT
// shutdown handler so the final tick flushes before exit.

import { createLogger } from '@/lib/logger';

const log = createLogger('agent-status-batcher');

/**
 * Per-agent status update queued for the next flush tick. Fields
 * mirror the writable columns of `agent_runs` that transient
 * transitions touch — the flush callback is responsible for mapping
 * these into a DB UPDATE.
 */
export interface StatusUpdate {
  status: string;
  lastActiveAt: Date;
  /** Sleep deadline (Phase D Sleep tool). Pass `null` to clear. Omit to leave untouched. */
  sleepUntil?: Date | null;
  /** Set on terminal-but-non-throwing paths if a caller batches them. Optional. */
  shutdownReason?: string | null;
  /** Latest cumulative token count for this run. Last-write-wins. */
  totalTokens?: number;
  /** Latest cumulative tool-use count for this run. Last-write-wins. */
  toolUses?: number;
  /** BullMQ job id stamped on the run row (queued → running transitions). */
  bullmqJobId?: string | null;
}

/** Flush payload — the agentId joined with the latest StatusUpdate. */
export interface FlushPayload extends StatusUpdate {
  agentId: string;
}

export interface AgentStatusBatcherOptions {
  flushIntervalMs: number;
  /** Caller-supplied flush. Receives the deduped batch; resolves when persisted. */
  flush: (payload: FlushPayload[]) => Promise<void>;
}

/**
 * Batches transient `agent_runs` status updates per `flushIntervalMs`
 * tick. Thread-safety: not designed for cross-process use — one
 * instance lives in each worker process and serializes writes through
 * its own event loop. Multiple workers writing the same row do not
 * coordinate through the batcher; the DB row is the source of truth.
 */
export class AgentStatusBatcher {
  private buffer = new Map<string, StatusUpdate>();
  private readonly timer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly opts: AgentStatusBatcherOptions) {
    this.timer = setInterval(() => {
      void this.flushNow().catch((err) => {
        // Re-buffer is already handled inside flushNow; surface the
        // error so ops can see the cadence of failed ticks. Swallow
        // here to keep the interval alive (an unhandled rejection
        // from setInterval crashes the process under Bun).
        log.warn(
          `agent-status-batcher tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, opts.flushIntervalMs);
    // Don't keep the event loop alive just because of this timer; the
    // worker process has its own keepalive (BullMQ).
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /**
   * Queue an update for `agentId`. Subsequent calls for the same id
   * before the next flush tick overwrite earlier ones (last-write-wins).
   */
  set(agentId: string, update: StatusUpdate): void {
    if (this.disposed) {
      // After dispose, drop silently — the dispose path already fired
      // a final flush; new entries can't be persisted on this batcher.
      log.warn(`set() after dispose for agent=${agentId} — dropping`);
      return;
    }
    this.buffer.set(agentId, update);
  }

  /**
   * Drop any buffered update for this agentId without flushing it.
   * Callers issuing a SYNCHRONOUS TERMINAL write (markFailed, final
   * exit, Sleep-tool sleeping write) MUST call this immediately before
   * their `db.update(agentRuns).set(...)` to prevent the next batcher
   * tick from overwriting their durable terminal write with a stale
   * buffered transient state (e.g. a 'running' set ~50ms earlier that
   * hasn't flushed yet).
   *
   * Concretely the race window without invalidate():
   *   1. statusBatcher.set(a, { status: 'running' })   // buffered, not yet flushed
   *   2. markFailed(a, ...) → db.update.set({ status: 'failed' })  // sync write lands
   *   3. ~500ms later: batcher tick → flushes buffered 'running'
   *      → OVERWRITES 'failed' in agent_runs. Bug.
   *
   * No-op when no entry is buffered for `agentId`.
   */
  invalidate(agentId: string): void {
    this.buffer.delete(agentId);
  }

  /**
   * Drain the buffer through the flush callback. No-op when empty.
   * On rejection, the in-flight batch is re-buffered so the next tick
   * retries; entries written DURING the failed flush survive (Map.set
   * preserves newer values via the post-fail merge).
   */
  async flushNow(): Promise<void> {
    if (this.buffer.size === 0) return;
    const batch: FlushPayload[] = Array.from(
      this.buffer,
      ([agentId, u]) => ({ agentId, ...u }),
    );
    this.buffer.clear();
    try {
      await this.opts.flush(batch);
    } catch (err) {
      // Re-buffer the failed batch. If a newer update for the same
      // agentId landed during the failed flush, prefer the newer one —
      // skip overwriting on collision.
      for (const item of batch) {
        if (!this.buffer.has(item.agentId)) {
          const { agentId, ...rest } = item;
          this.buffer.set(agentId, rest);
        }
      }
      throw err;
    }
  }

  /**
   * Clear the interval and AWAIT a final flush. Idempotent. Wire this
   * into your worker's SIGTERM/SIGINT handler — and `await` the
   * returned promise — so a pending tick's UPDATEs make it to Postgres
   * before `process.exit(0)`. A sync wrapper + empirical `setTimeout`
   * grace window is NOT safe under a slow DB or a large pending
   * buffer: the round-trips outlast the grace and the UPDATEs are
   * dropped on exit.
   *
   * Subsequent calls after the first complete resolve immediately
   * (idempotent — they neither re-flush nor throw).
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    try {
      await this.flushNow();
    } catch (err) {
      log.warn(
        `agent-status-batcher final flush failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Pending entry count — useful for /api/admin/queue-stats. */
  size(): number {
    return this.buffer.size;
  }
}
