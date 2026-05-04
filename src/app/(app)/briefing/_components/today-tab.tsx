'use client';

import { TodayBody } from '@/app/(app)/today/today-content';

/**
 * Briefing → Today tab. Re-uses the extracted <TodayBody> from the
 * legacy /today route so both surfaces share one implementation
 * during the migration window.
 */
export function TodayTab() {
  return <TodayBody />;
}
