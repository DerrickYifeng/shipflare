import type { Metadata } from 'next';
import { PlanTab } from '../_components/plan-tab';

export const metadata: Metadata = { title: 'Briefing — Plan' };
export const dynamic = 'force-dynamic';

export default function BriefingPlanPage() {
  return <PlanTab />;
}
