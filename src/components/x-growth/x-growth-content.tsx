'use client';

import { useState } from 'react';
import { TargetAccounts } from '@/components/x-growth/target-accounts';
import { ReplyQueue } from '@/components/x-growth/reply-queue';
import { EngagementAlerts } from '@/components/x-growth/engagement-alerts';
import { MetricsPanel } from '@/components/x-growth/metrics-panel';

type Tab = 'targets' | 'replies' | 'engagement' | 'metrics';

const tabs: { id: Tab; label: string }[] = [
  { id: 'targets', label: 'Targets' },
  { id: 'replies', label: 'Reply Queue' },
  { id: 'engagement', label: 'Engagement' },
  { id: 'metrics', label: 'Analytics' },
];

export function XGrowthContent() {
  const [activeTab, setActiveTab] = useState<Tab>('targets');

  return (
    <div className="flex-1 p-6">
      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-6 border-b border-[rgba(0,0,0,0.08)] pb-px">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`
              px-3 py-2 text-[14px] tracking-[-0.224px] font-medium rounded-t-[var(--radius-sf-md)]
              transition-colors duration-200 border-b-2 -mb-px
              ${activeTab === tab.id
                ? 'border-sf-accent text-sf-text-primary'
                : 'border-transparent text-sf-text-secondary hover:text-sf-text-primary'
              }
            `}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'targets' && <TargetAccounts />}
      {activeTab === 'replies' && <ReplyQueue />}
      {activeTab === 'engagement' && <EngagementAlerts />}
      {activeTab === 'metrics' && <MetricsPanel />}
    </div>
  );
}
