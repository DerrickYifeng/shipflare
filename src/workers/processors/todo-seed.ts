import type { Job } from 'bullmq';
import { db } from '@/lib/db';
import { users, userPreferences } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { seedTodosForUser, getLocalHour } from '@/lib/today/seed';
import { createLogger } from '@/lib/logger';
import type { TodoSeedJobData } from '@/lib/queue/types';

const log = createLogger('worker:todo-seed');

export async function processTodoSeed(job: Job<TodoSeedJobData>) {
  const { userId } = job.data;

  // Cron fan-out: scan all users and seed those at 8 AM local time
  if (userId === '__all__') {
    const allUsers = await db.select({ id: users.id }).from(users);
    const now = new Date();
    let seeded = 0;

    for (const user of allUsers) {
      const [prefs] = await db
        .select({ timezone: userPreferences.timezone })
        .from(userPreferences)
        .where(eq(userPreferences.userId, user.id))
        .limit(1);

      const tz = prefs?.timezone ?? 'America/Los_Angeles';
      const localHour = getLocalHour(now, tz);

      if (localHour !== 8) continue;

      try {
        const count = await seedTodosForUser(user.id);
        if (count > 0) seeded++;
      } catch (err: unknown) {
        log.error(
          `Todo seed failed for user ${user.id}: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
      }
    }

    log.info(`Cron todo-seed: seeded ${seeded}/${allUsers.length} users`);
    return;
  }

  // Single user seed
  const count = await seedTodosForUser(userId);
  log.info(`Seeded ${count} todo items for user ${userId}`);
}
