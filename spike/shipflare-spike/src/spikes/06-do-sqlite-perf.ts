import type { Env } from "../index";

/**
 * Spike #6 handler.
 *
 * Drives `SqliteDO` through a 10000-row seed and a 50-sample benchmark,
 * returns concrete p50/p99/max latency numbers in milliseconds.
 */
export default async function handler(_req: Request, env: Env): Promise<Response> {
  const convId = "spike-conv";
  const stub = env.SQLITE_DO.getByName("perf-test");
  const seed = await stub.seed(10000, convId);
  const bench = await stub.benchmark(convId, 50);
  return Response.json({
    seedMs: seed.ms,
    seedRowsPerSec: Math.round(10000 / (seed.ms / 1000)),
    rowsInserted: seed.rowsInserted,
    select: bench.select, // { p50, p99, max } in ms
    insert: bench.insert,
    thresholds: { selectP99Max: 50, insertP99Max: 5 },
  });
}
