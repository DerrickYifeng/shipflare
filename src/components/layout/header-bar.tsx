import { HealthScoreRing } from '@/components/dashboard/health-score-ring';

interface HeaderBarProps {
  title: string;
  healthScore?: number | null;
}

export function HeaderBar({ title, healthScore }: HeaderBarProps) {
  return (
    <div className="flex items-center justify-between px-6 py-5">
      <h1 className="text-[28px] font-semibold text-sf-text-primary tracking-[0.196px] leading-[1.14]">{title}</h1>
      {healthScore != null && (
        <div className="flex items-center gap-2">
          <HealthScoreRing score={healthScore} size={36} />
          <span className="text-[14px] font-mono text-sf-text-secondary tracking-[-0.224px]">
            {healthScore}
          </span>
        </div>
      )}
    </div>
  );
}
