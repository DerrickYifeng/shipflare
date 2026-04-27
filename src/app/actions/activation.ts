'use server';

import { auth } from '@/lib/auth';
import { createLogger } from '@/lib/logger';

const log = createLogger('actions:activation');

/**
 * Phase 2 stub. The v1 post-onboarding activation enqueued `calendar-plan` jobs
 * for each connected channel. That queue + planner agent were removed in the
 * planner refresh migration. The replacement is the strategic+tactical planner
 * chain triggered by `POST /api/onboarding/commit` in Phase 8, which also owns
 * its own dedupe (products_user_uq + onboardingCompletedAt) so this server
 * action becomes a no-op during the migration.
 */
export async function activatePostOnboarding(): Promise<{
  enqueued: string[];
  skipped: string[];
}> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error('Unauthorized');
  }
  log.info(
    `activatePostOnboarding no-op during v2 migration (user=${session.user.id})`,
  );
  return { enqueued: [], skipped: [] };
}
