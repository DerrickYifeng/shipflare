import type { TodayStats } from '@/hooks/use-today';

interface CompletionStateProps {
  stats: TodayStats;
}

export function CompletionState({ stats }: CompletionStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 animate-sf-fade-in">
      <div className="w-16 h-16 rounded-full bg-sf-success/10 flex items-center justify-center mb-6">
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-sf-success"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>

      <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-2">
        Today&apos;s marketing is handled.
      </h2>

      {stats.acted_today > 0 && (
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary mb-1 leading-[1.47]">
          {stats.acted_today} {stats.acted_today === 1 ? 'task' : 'tasks'} completed today.
        </p>
      )}

      {stats.published_yesterday > 0 && (
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary mb-4 leading-[1.47]">
          {stats.published_yesterday} {stats.published_yesterday === 1 ? 'post' : 'posts'} published yesterday.
        </p>
      )}

      <p className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary leading-[1.47]">
        New tasks tomorrow morning.
      </p>
    </div>
  );
}
