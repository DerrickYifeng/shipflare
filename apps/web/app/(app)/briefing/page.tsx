/**
 * `/briefing` — founder's daily approval inbox.
 *
 * Ported from Railway. Data fetching replaced: Railway used SWR +
 * `/api/today` (Postgres). CF uses browser→core CmoClient per spec D13.
 *
 * Auth gate lives in `(app)/layout.tsx` — this page is always protected.
 * `force-dynamic` is inherited from the parent layout but declared here
 * explicitly so it stays visible to readers of this file.
 */

import { TodayTab } from "./_components/today-tab";

export const dynamic = "force-dynamic";

export default function BriefingPage() {
  return <TodayTab />;
}
