import type { Metadata } from 'next';
import { TodayTab } from './_components/today-tab';

export const metadata: Metadata = { title: 'Briefing — Today' };
// Layout already runs auth + onboarding gates. Force dynamic so SWR
// gets fresh data on every navigation.
export const dynamic = 'force-dynamic';

export default function BriefingTodayPage() {
  return <TodayTab />;
}
