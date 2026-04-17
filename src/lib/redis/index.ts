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

/**
 * Typed channel buckets for user-scoped SSE events.
 *
 * Consumers (the `/api/events` SSE endpoint) can subscribe either to the
 * root namespace (`shipflare:events:${userId}`) to receive everything, or to
 * one of the per-channel namespaces below to receive a filtered slice.
 *
 * Kept narrow on purpose — any new bucket should be a deliberate decision,
 * not a typo magnet. If you need a new bucket, add it here and wire up the
 * `/api/events` `?channel=` validation to accept it.
 */
export type UserEventChannel = 'agents' | 'drafts' | 'tweets';

/**
 * Publish an event for `userId` into a given logical channel.
 *
 * Dual-writes to:
 *   1. `shipflare:events:${userId}`            — root bucket, back-compat for
 *      existing consumers that subscribe to the root key without a filter.
 *   2. `shipflare:events:${userId}:${channel}` — per-channel bucket, used by
 *      `/api/events?channel=<channel>` so the reply-queue / drafts UI can
 *      subscribe to only the events they care about.
 *
 * Each publisher picks the right `channel` based on what it emits:
 *   - `drafts`  : new / reviewed / auto-approved drafts (the reply queue refreshes)
 *   - `tweets`  : monitored tweets, engagement mentions (the tweet list refreshes)
 *   - `agents`  : everything else — agent lifecycle, analytics, calibration
 */
export async function publishUserEvent(
  userId: string,
  channel: UserEventChannel,
  data: Record<string, unknown>,
): Promise<void> {
  const payload = JSON.stringify(data);
  const publisher = getPubSubPublisher();
  await Promise.all([
    publisher.publish(`shipflare:events:${userId}`, payload),
    publisher.publish(`shipflare:events:${userId}:${channel}`, payload),
  ]);
}
