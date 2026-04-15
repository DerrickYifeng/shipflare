'use client';

import { useAutomationStatus } from '@/hooks/use-automation-status';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) {
    // Future
    const absDiff = Math.abs(diff);
    if (absDiff < 60_000) return 'in <1m';
    if (absDiff < 3600_000) return `in ${Math.round(absDiff / 60_000)}m`;
    return `in ${Math.round(absDiff / 3600_000)}h`;
  }
  if (diff < 60_000) return '<1m ago';
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / 86400_000)}d ago`;
}

const statusDot: Record<string, string> = {
  healthy: 'bg-sf-success',
  warning: 'bg-sf-warning',
  error: 'bg-sf-error',
};

export function PipelineStatus() {
  const { pipelines, draftCounts, isLoading } = useAutomationStatus();

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 mb-6">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-secondary uppercase">
          Pipeline Status
        </h3>
        <div className="flex items-center gap-3 text-[12px] tracking-[-0.12px] text-sf-text-tertiary">
          <span>{draftCounts.pending} pending</span>
          <span>{draftCounts.approved} approved</span>
          <span>{draftCounts.posted} posted</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {pipelines.map((p) => (
          <div
            key={p.name}
            className="rounded-[var(--radius-sf-lg)] p-4 bg-sf-bg-secondary shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)]"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-2 h-2 rounded-full ${statusDot[p.status] ?? 'bg-sf-text-tertiary'}`} />
              <span className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary">{p.name}</span>
              {p.errorCount > 0 && (
                <Badge variant="error" mono>
                  {p.errorCount} err
                </Badge>
              )}
            </div>
            <div className="flex flex-col gap-0.5 text-[12px] tracking-[-0.12px] text-sf-text-tertiary">
              <span>Last: {relativeTime(p.lastRun)}</span>
              <span>Next: {relativeTime(p.nextRun)}</span>
              <span className="text-[12px] tracking-[-0.12px]">{p.cronDescription}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
