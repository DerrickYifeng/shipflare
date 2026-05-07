'use client';

import { TodayBody } from '@/app/(app)/today/today-content';

/**
 * Briefing → Today tab. Re-uses the extracted <TodayBody> from the
 * legacy /today route so both surfaces share one implementation
 * during the migration window.
 *
 * The Plan tab renders `CalendarContent`, whose internal `HeaderBar`
 * provides 28px of top padding. `TodayBody` has no equivalent header,
 * so we add a matching top spacer here to keep the gap below the tab
 * nav consistent across tabs.
 */
export function TodayTab() {
  return (
    <div style={{ paddingTop: 28 }}>
      <TodayBody />
    </div>
  );
}
