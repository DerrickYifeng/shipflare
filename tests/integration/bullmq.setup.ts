// Integration test harness for BullMQ.
//
// To run, first start a dedicated Redis on port 6390 (keeps the dev Redis on
// 6379 untouched so queue obliteration can't destroy in-flight dev data):
//
//   redis-server --port 6390 --save '' --daemonize yes
//   bun run test:integration
//
// This setup file is wired via `vitest.integration.config.ts` → `setupFiles`,
// so it executes once per test worker BEFORE any test file (and therefore
// before `@/lib/queue` is imported at module-eval time). Overriding
// `REDIS_URL` here routes every queue/worker created by the app code to the
// sandboxed test Redis.

const TEST_REDIS_PORT = process.env.REDIS_TEST_PORT ?? '6390';
process.env.REDIS_URL = `redis://127.0.0.1:${TEST_REDIS_PORT}`;

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const connection = new IORedis({
  host: '127.0.0.1',
  port: Number(TEST_REDIS_PORT),
  maxRetriesPerRequest: null,
});

export async function flushQueue(q: Queue): Promise<void> {
  await q.obliterate({ force: true });
}
