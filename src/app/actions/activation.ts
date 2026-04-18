'use server';

import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { channels, products } from '@/lib/db/schema';
import { enqueueCalendarPlan } from '@/lib/queue';
import { getKeyValueClient } from '@/lib/redis';
import { isPlatformAvailable, PLATFORMS } from '@/lib/platform-config';
import { createLogger } from '@/lib/logger';

const log = createLogger('actions:activation');

/**
 * Short Redis-lock helper: `SET NX EX` so repeated calls within the TTL
 * no-op. Returns `true` if this caller acquired the lock.
 */
async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  const kv = getKeyValueClient();
  const result = await kv.set(key, '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

function weekStartUtc(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  // Monday-anchored ISO week to match planner semantics.
  const day = d.getUTCDay();
  const diff = (day + 6) % 7; // Mon=0, Sun=6
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

/**
 * Fire after the user completes the ConnectAccounts onboarding step.
 *
 * For each connected + enabled platform, enqueue a `calendar-plan` job so the
 * user arrives at `/today` with an in-flight plan instead of an empty grid.
 * Deduped on `(userId, platform, weekStart)` via a 1h Redis lock — re-entering
 * ConnectAccounts (e.g. OAuth popups that bounce back to the same step) does
 * not double-enqueue.
 *
 * No-ops if the user hasn't connected any channel yet — the "Skip for now"
 * path stays free.
 */
export async function activatePostOnboarding(): Promise<{
  enqueued: string[];
  skipped: string[];
}> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error('Unauthorized');
  }
  const userId = session.user.id;

  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  if (!product) {
    log.info(`No product for user ${userId}, skipping auto-calendar`);
    return { enqueued: [], skipped: [] };
  }

  // Explicit projection — token columns are off-limits here (see CLAUDE.md
  // Security TODO). We only need the platform identifier.
  const userChannels = await db
    .select({ platform: channels.platform })
    .from(channels)
    .where(eq(channels.userId, userId));

  const connected = [...new Set(userChannels.map((c) => c.platform))].filter(
    isPlatformAvailable,
  );

  if (connected.length === 0) {
    return { enqueued: [], skipped: [] };
  }

  // Plan window: next hour of the current UTC week — calendar-plan already
  // rounds start time to the next top-of-hour. We anchor the dedupe lock on
  // the ISO week-start so re-opening onboarding within the same week
  // collapses into one plan per platform.
  const now = new Date();
  const startDate = new Date(now);
  startDate.setMinutes(0, 0, 0);
  startDate.setHours(startDate.getHours() + 1);

  const weekKey = weekStartUtc(now).toISOString().slice(0, 10);

  const enqueued: string[] = [];
  const skipped: string[] = [];

  for (const platform of connected) {
    const lockKey = `autocal:${userId}:${platform}:${weekKey}`;
    const acquired = await acquireLock(lockKey, 60 * 60);
    if (!acquired) {
      log.info(
        `skip auto-calendar for ${platform} (lock held) user=${userId} week=${weekKey}`,
      );
      skipped.push(platform);
      continue;
    }

    const channel = PLATFORMS[platform]?.id ?? platform;
    try {
      const jobId = await enqueueCalendarPlan({
        userId,
        productId: product.id,
        channel,
        startDate: startDate.toISOString(),
      });
      enqueued.push(platform);
      log.info(
        `auto-calendar enqueued user=${userId} platform=${platform} jobId=${jobId}`,
      );
    } catch (err: unknown) {
      log.error(
        `auto-calendar enqueue failed for ${platform} user=${userId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { enqueued, skipped };
}
