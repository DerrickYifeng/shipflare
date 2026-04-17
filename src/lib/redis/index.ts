import IORedis from 'ioredis';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:redis');
const redisUrl = process.env.REDIS_URL!;

/**
 * We maintain three separate singleton Redis connections so their
 * failure/backpressure characteristics don't bleed into one another:
 *
 *  - BullMQ connection: requires `maxRetriesPerRequest: null` and
 *    `enableReadyCheck: false` — a blocked BLPOP shouldn't be sharing
 *    socket state with pub/sub or regular KV traffic.
 *  - Pub/sub publisher: used by `publishEvent` to fan events out to SSE
 *    subscribers. Short-lived PUBLISH commands only.
 *  - Key/value client: plain reads/writes (`GET`/`SET`/`INCR`) for things
 *    like monitor sinceIds and rate-limit counters.
 *
 * Pub/sub subscribers each need their own dedicated connection (Redis
 * pub/sub is stateful per socket), so `createPubSubSubscriber` always
 * returns a fresh instance.
 */

let _bullmq: IORedis | null = null;
let _pubsubPublisher: IORedis | null = null;
let _kv: IORedis | null = null;

function instrument(client: IORedis, label: string): IORedis {
  client.on('connect', () => log.info(`Redis[${label}] connected`));
  client.on('error', (err) => log.error(`Redis[${label}] error:`, err.message));
  client.on('close', () => log.warn(`Redis[${label}] connection closed`));
  return client;
}

/**
 * Connection reserved for BullMQ queues & workers.
 * BullMQ mandates `maxRetriesPerRequest: null` and disables ready-check.
 */
export function getBullMQConnection(): IORedis {
  if (!_bullmq) {
    _bullmq = instrument(
      new IORedis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      }),
      'bullmq',
    );
  }
  return _bullmq;
}

/**
 * Connection reserved for pub/sub PUBLISH commands.
 * Safe to reuse across publishers because PUBLISH is a one-shot command.
 */
export function getPubSubPublisher(): IORedis {
  if (!_pubsubPublisher) {
    _pubsubPublisher = instrument(
      new IORedis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      }),
      'pubsub-pub',
    );
  }
  return _pubsubPublisher;
}

/**
 * Connection for general key/value reads & writes (GET/SET/INCR/etc).
 * Use this for feature flags, counters, cursors, rate-limit windows.
 */
export function getKeyValueClient(): IORedis {
  if (!_kv) {
    _kv = instrument(
      new IORedis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      }),
      'kv',
    );
  }
  return _kv;
}

/**
 * Create a new Redis connection for pub/sub subscribers.
 * Each SSE client needs its own subscriber (Redis pub/sub is stateful per connection).
 */
export function createPubSubSubscriber(): IORedis {
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/**
 * @deprecated Prefer `getBullMQConnection`, `getPubSubPublisher`, or
 * `getKeyValueClient`. Retained as a back-compat alias (routes to the
 * key/value client) so we can land the split incrementally.
 */
export function getRedis(): IORedis {
  return getKeyValueClient();
}

/**
 * Publish an event to a Redis channel.
 */
export async function publishEvent(
  channel: string,
  data: Record<string, unknown>,
): Promise<void> {
  await getPubSubPublisher().publish(channel, JSON.stringify(data));
}
