import IORedis from 'ioredis';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:redis');
const redisUrl = process.env.REDIS_URL!;

/**
 * Singleton Redis connection for BullMQ queues and general use.
 * BullMQ requires ioredis (not the generic redis package).
 */
let _redis: IORedis | null = null;

export function getRedis(): IORedis {
  if (!_redis) {
    _redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableReadyCheck: false,
    });
    _redis.on('connect', () => log.info('Redis connected'));
    _redis.on('error', (err) => log.error('Redis error:', err.message));
    _redis.on('close', () => log.warn('Redis connection closed'));
  }
  return _redis;
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
 * Publish an event to a Redis channel.
 */
export async function publishEvent(
  channel: string,
  data: Record<string, unknown>,
): Promise<void> {
  await getRedis().publish(channel, JSON.stringify(data));
}
