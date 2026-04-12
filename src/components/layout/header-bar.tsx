import { HealthScoreRing } from '@/components/dashboard/health-score-ring';

interface HeaderBarProps {
  title: string;
  healthScore?: number | null;
}

export function HeaderBar({ title, healthScore }: HeaderBarProps) {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-sf-border bg-sf-bg-primary">
      <h1 className="text-[18px] font-semibold text-sf-text-primary">{title}</h1>
      {healthScore != null && (
        <div className="flex items-center gap-2">
          <HealthScoreRing score={healthScore} size={36} />
          <span className="text-[13px] font-mono text-sf-text-secondary">
            {healthScore}
          </span>
        </div>
      )}
    </div>
  );
}
