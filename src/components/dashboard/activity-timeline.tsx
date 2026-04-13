'use client';

import { useActivity } from '@/hooks/use-activity';
import { Badge } from '@/components/ui/badge';

const eventLabels: Record<string, { label: string; variant: 'success' | 'error' | 'warning' | 'default' }> = {
  discovery_scan: { label: 'Discovery', variant: 'default' },
  draft_created: { label: 'Draft', variant: 'default' },
  post_published: { label: 'Posted', variant: 'success' },
  post_failed: { label: 'Failed', variant: 'error' },
  circuit_breaker_trip: { label: 'Breaker', variant: 'error' },
};

export function ActivityTimeline() {
  const { events, isLoading } = useActivity();

  if (isLoading || events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[13px] text-sf-text-tertiary">
        {isLoading ? 'Loading...' : 'No recent activity'}
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2 px-1">
      {events.map((event) => {
        const config = eventLabels[event.eventType] ?? { label: event.eventType, variant: 'default' as const };
        const meta = event.metadataJson;
        const community = (meta?.community as string) ?? '';
        const time = new Date(event.createdAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });

        return (
          <div
            key={event.id}
            className="shrink-0 flex flex-col gap-1.5 p-3 bg-sf-bg-secondary rounded-[var(--radius-sf-md)] min-w-[120px]"
          >
            <Badge variant={config.variant}>{config.label}</Badge>
            {community && (
              <span className="text-[11px] text-sf-text-secondary">{community}</span>
            )}
            <span className="text-[11px] text-sf-text-tertiary font-mono">{time}</span>
          </div>
        );
      })}
    </div>
  );
}
