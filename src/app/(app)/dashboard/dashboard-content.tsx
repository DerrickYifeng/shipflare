'use client';

import { DraftQueue } from '@/components/dashboard/draft-queue';
import { DiscoveryFeed } from '@/components/dashboard/discovery-feed';

export function DashboardContent() {
  return (
    <div className="flex flex-col flex-1">
      <div className="flex-1 flex flex-col lg:flex-row gap-0 overflow-hidden">
        {/* Draft Queue: 60% */}
        <section
          className="lg:w-3/5 border-r border-sf-border overflow-y-auto p-4"
          aria-label="Draft queue"
        >
          <h2 className="text-[13px] font-medium text-sf-text-secondary uppercase tracking-wider mb-3">
            Draft Queue
          </h2>
          <DraftQueue />
        </section>

        {/* Discovery Feed: 40% */}
        <section
          className="lg:w-2/5 overflow-y-auto p-4"
          aria-label="Discovery feed"
        >
          <h2 className="text-[13px] font-medium text-sf-text-secondary uppercase tracking-wider mb-3">
            Discovery
          </h2>
          <DiscoveryFeed />
        </section>
      </div>
    </div>
  );
}
