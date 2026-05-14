import { DurableObject } from "cloudflare:workers";
import type { Env } from "../index";

// MsgRow must be a `type` with index-signature compatibility (not an
// `interface`) so it satisfies `Record<string, SqlStorageValue>` — the generic
// constraint on `SqlStorage.exec<T>`. Interfaces don't auto-satisfy index
// signatures even when all members are assignable.
type MsgRow = {
  id: number;
  conv_id: string;
  ts: number;
  content: string;
};

/**
 * Spike #6 — DO SQLite performance probe.
 *
 * Validates that Cloudflare DO SQLite can hit acceptable per-row latency
 * for ShipFlare's per-team state. Methods:
 *   - seed(rows, convId): bulk insert N rows in a single transaction.
 *     BEGIN/COMMIT is critical — per-row commit dominates without it.
 *   - timedSelect(convId): single indexed `WHERE conv_id ORDER BY ts`.
 *   - timedInsert(convId): single one-shot INSERT.
 *   - benchmark(convId, samples): drive N timed selects + N timed inserts,
 *     return p50/p99/max for each. Sampling is done inside the DO to keep
 *     measurement off the RPC hop.
 *
 * Pass thresholds: SELECT p99 < 50ms, INSERT p99 < 5ms.
 */
export class SqliteDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conv_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          content TEXT NOT NULL
        );
      `);
      this.ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conv_id, ts);`,
      );
    });
  }

  async seed(rows: number, convId: string): Promise<{ ms: number; rowsInserted: number }> {
    const t = Date.now();
    // DO SQLite forbids raw `BEGIN TRANSACTION` / `SAVEPOINT` SQL — workerd
    // throws explicitly with a hint to use the JS API instead. Per-row commit
    // otherwise dominates the measurement, so we wrap the bulk seed in
    // `transactionSync` which interacts correctly with DO's automatic atomic
    // write coalescing and rolls back on throw.
    this.ctx.storage.transactionSync(() => {
      for (let i = 0; i < rows; i++) {
        this.ctx.storage.sql.exec(
          "INSERT INTO messages (conv_id, ts, content) VALUES (?, ?, ?)",
          convId,
          Date.now() + i,
          `msg-${i}-${Math.random().toString(36).slice(2, 18)}`,
        );
      }
    });
    return { ms: Date.now() - t, rowsInserted: rows };
  }

  async timedSelect(convId: string): Promise<{ ms: number; count: number }> {
    const t = Date.now();
    const rows = this.ctx.storage.sql
      .exec<MsgRow>(
        "SELECT id, ts, content FROM messages WHERE conv_id = ? ORDER BY ts",
        convId,
      )
      .toArray();
    return { ms: Date.now() - t, count: rows.length };
  }

  async timedInsert(convId: string): Promise<{ ms: number }> {
    const t = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (conv_id, ts, content) VALUES (?, ?, ?)",
      convId,
      Date.now(),
      "one-shot",
    );
    return { ms: Date.now() - t };
  }

  // Spike #9 — Cron fan-out marker. Writes a single row tagged with
  // conv_id='cron-marker' so the scheduled() handler can prove it fanned
  // out to this DO and Phase 1 can observe per-tick activity without
  // adding a new table. `scheduledTime` echoes the `ScheduledController`
  // field so tests can assert the exact tick they triggered.
  async markCronTick(scheduledTime: number): Promise<{ count: number }> {
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (conv_id, ts, content) VALUES (?, ?, ?)",
      "cron-marker",
      scheduledTime,
      `cron@${scheduledTime}`,
    );
    const row = this.ctx.storage.sql
      .exec<{ c: number }>(
        "SELECT COUNT(*) as c FROM messages WHERE conv_id = ?",
        "cron-marker",
      )
      .one();
    return { count: row.c };
  }

  async listCronMarkers(): Promise<Array<{ ts: number; content: string }>> {
    return this.ctx.storage.sql
      .exec<{ ts: number; content: string }>(
        "SELECT ts, content FROM messages WHERE conv_id = 'cron-marker' ORDER BY ts DESC LIMIT 10",
      )
      .toArray();
  }

  // Sample N timed selects + N timed inserts in-DO; return p50/p99/max.
  async benchmark(
    convId: string,
    samples: number,
  ): Promise<{
    select: { p50: number; p99: number; max: number };
    insert: { p50: number; p99: number; max: number };
  }> {
    const selectMs: number[] = [];
    const insertMs: number[] = [];
    for (let i = 0; i < samples; i++) {
      selectMs.push((await this.timedSelect(convId)).ms);
      insertMs.push((await this.timedInsert(convId)).ms);
    }
    selectMs.sort((a, b) => a - b);
    insertMs.sort((a, b) => a - b);
    // Math.floor((n-1) * p) → correct index for sorted-ascending arrays.
    // samples=50 → p99 index = 49 (max). samples=100 → p99 = index 99.
    const pct = (arr: number[], p: number): number => arr[Math.floor((arr.length - 1) * p)]!;
    return {
      select: {
        p50: pct(selectMs, 0.5),
        p99: pct(selectMs, 0.99),
        max: selectMs[selectMs.length - 1]!,
      },
      insert: {
        p50: pct(insertMs, 0.5),
        p99: pct(insertMs, 0.99),
        max: insertMs[insertMs.length - 1]!,
      },
    };
  }
}
