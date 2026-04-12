import { db } from '@/lib/db';
import { activityEvents } from '@/lib/db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';

const BREAKER_WINDOW_HOURS = 24;

/**
 * Check if the circuit breaker is tripped for a user.
 * Trips on: mod removal, account warning, shadowban detection.
 * Resets after 24 hours or manual reset.
 */
export async function isCircuitBreakerTripped(
  userId: string,
): Promise<{ tripped: boolean; reason?: string; trippedAt?: Date }> {
  const windowStart = new Date(
    Date.now() - BREAKER_WINDOW_HOURS * 60 * 60 * 1000,
  );

  const events = await db
    .select()
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.userId, userId),
        eq(activityEvents.eventType, 'circuit_breaker_trip'),
        gte(activityEvents.createdAt, windowStart),
      ),
    )
    .orderBy(desc(activityEvents.createdAt))
    .limit(1);

  if (events.length === 0) {
    return { tripped: false };
  }

  const event = events[0]!;
  const metadata = event.metadataJson as { reason?: string } | null;

  return {
    tripped: true,
    reason: metadata?.reason ?? 'Unknown',
    trippedAt: event.createdAt,
  };
}

/**
 * Trip the circuit breaker for a user.
 */
export async function tripCircuitBreaker(
  userId: string,
  reason: string,
): Promise<void> {
  await db.insert(activityEvents).values({
    userId,
    eventType: 'circuit_breaker_trip',
    metadataJson: { reason },
  });
}
