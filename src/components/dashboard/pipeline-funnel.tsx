const STAGE_LABELS: Record<string, string> = {
  discovered: 'Discovered',
  gate_passed: 'Gate passed',
  draft_created: 'Draft created',
  reviewed: 'Reviewed',
  approved: 'Approved',
  posted: 'Posted',
};

interface FunnelRow {
  stage: string;
  count: number;
}

interface LatencyRow {
  stage: string;
  p50Ms: number;
  p95Ms: number;
  samples: number;
}

interface PipelineFunnelProps {
  funnel: FunnelRow[];
  discoveredCount: number;
  latencyTable: LatencyRow[];
  failedCount: number;
  engagedCount: number;
}

function formatDuration(ms: number): string {
  if (!ms) return '—';
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Pipeline funnel visual.
 *
 * (a) Horizontal bar chart where each row's width is the stage count as
 *     a percent of `discoveredCount` (top-of-funnel). No charting lib —
 *     just Tailwind-width + a nested gradient bar.
 *
 * (b) Per-stage p50/p95 latency table. Only `draft_created` carries a
 *     durationMs today (elapsed since the matching 'discovered' event);
 *     other stages show 0 samples until further instrumentation lands.
 */
export function PipelineFunnel({
  funnel,
  discoveredCount,
  latencyTable,
  failedCount,
  engagedCount,
}: PipelineFunnelProps) {
  const maxCount = Math.max(discoveredCount, 1);

  return (
    <section aria-label="Pipeline funnel" className="flex flex-col gap-6 max-w-4xl">
      <div>
        <h2 className="text-[17px] font-semibold text-sf-text-primary tracking-[-0.374px] mb-1">
          Pipeline Funnel
        </h2>
        <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary">
          Last 7 days. Discovered → Gate passed → Draft created → Reviewed →
          Approved → Posted.
        </p>
      </div>

      {/* Funnel bars */}
      <div className="rounded-[var(--radius-sf-lg)] p-5 bg-sf-bg-secondary shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)]">
        {discoveredCount === 0 ? (
          <p className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary">
            No pipeline events in the last 7 days. Run discovery to populate
            the funnel.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {funnel.map(({ stage, count }) => {
              const percent = maxCount > 0 ? (count / maxCount) * 100 : 0;
              const conversionLabel =
                discoveredCount > 0
                  ? `${((count / discoveredCount) * 100).toFixed(0)}%`
                  : '—';
              return (
                <div
                  key={stage}
                  className="grid grid-cols-[140px_1fr_auto] items-center gap-3"
                >
                  <span className="text-[13px] tracking-[-0.13px] text-sf-text-secondary">
                    {STAGE_LABELS[stage] ?? stage}
                  </span>
                  <div className="h-6 rounded-[var(--radius-sf-sm)] bg-sf-bg-tertiary overflow-hidden">
                    <div
                      className="h-full bg-sf-accent transition-[width] duration-300"
                      style={{ width: `${Math.max(percent, 2)}%` }}
                      aria-hidden
                    />
                  </div>
                  <span className="text-[12px] tracking-[-0.12px] font-mono text-sf-text-secondary tabular-nums">
                    {count.toLocaleString()} <span className="text-sf-text-tertiary">({conversionLabel})</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {(failedCount > 0 || engagedCount > 0) && (
          <div className="mt-4 pt-3 border-t border-sf-border flex gap-6 text-[12px] tracking-[-0.12px]">
            {failedCount > 0 && (
              <span className="text-sf-text-tertiary">
                Failed:{' '}
                <span className="text-sf-error font-mono tabular-nums">
                  {failedCount}
                </span>
              </span>
            )}
            {engagedCount > 0 && (
              <span className="text-sf-text-tertiary">
                Engagement drafts:{' '}
                <span className="text-sf-text-secondary font-mono tabular-nums">
                  {engagedCount}
                </span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Latency table */}
      <div>
        <h3 className="text-[13px] tracking-[-0.13px] font-medium text-sf-text-secondary uppercase mb-2">
          Stage latency (p50 / p95)
        </h3>
        <div className="rounded-[var(--radius-sf-lg)] bg-sf-bg-secondary shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)] overflow-hidden">
          <table className="w-full text-[13px] tracking-[-0.13px]">
            <thead>
              <tr className="border-b border-sf-border">
                <th className="px-4 py-2 text-left font-medium text-sf-text-tertiary">
                  Stage
                </th>
                <th className="px-4 py-2 text-right font-medium text-sf-text-tertiary">
                  p50
                </th>
                <th className="px-4 py-2 text-right font-medium text-sf-text-tertiary">
                  p95
                </th>
                <th className="px-4 py-2 text-right font-medium text-sf-text-tertiary">
                  Samples
                </th>
              </tr>
            </thead>
            <tbody>
              {latencyTable.map((row) => (
                <tr key={row.stage} className="border-b border-sf-border last:border-b-0">
                  <td className="px-4 py-2 text-sf-text-secondary">
                    {STAGE_LABELS[row.stage] ?? row.stage}
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums text-sf-text-secondary">
                    {formatDuration(row.p50Ms)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums text-sf-text-secondary">
                    {formatDuration(row.p95Ms)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums text-sf-text-tertiary">
                    {row.samples.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
