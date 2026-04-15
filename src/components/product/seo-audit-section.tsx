import { Card } from '@/components/ui/card';
import type { SeoAuditResult } from '@/tools/seo-audit';

interface SeoAuditSectionProps {
  audit: SeoAuditResult | null;
}

export function SeoAuditSection({ audit }: SeoAuditSectionProps) {
  if (!audit || audit.checks.length === 0) return null;

  return (
    <section>
      <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-4">SEO Audit</h2>
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="text-[24px] font-semibold font-mono text-sf-text-primary tracking-[-0.374px]">
            {audit.score}
          </div>
          <div>
            <p className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary">SEO Score</p>
            <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary">
              {audit.checks.length} checks performed
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          {audit.checks.map((check) => (
            <div key={check.name} className="flex items-center justify-between py-1.5">
              <div className="flex items-center gap-2">
                {check.passed ? <CheckIcon /> : <XIcon />}
                <span className="text-[14px] tracking-[-0.224px] text-sf-text-primary">{check.name}</span>
              </div>
              {check.value && (
                <span className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary">{check.value}</span>
              )}
            </div>
          ))}
        </div>

        {audit.recommendations.length > 0 && (
          <div className="mt-4 pt-4 border-t border-[rgba(0,0,0,0.08)]">
            <p className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-secondary uppercase mb-2">
              Recommendations
            </p>
            <ul className="flex flex-col gap-1.5">
              {audit.recommendations.map((rec, i) => (
                <li key={i} className="text-[14px] tracking-[-0.224px] text-sf-text-secondary flex gap-2">
                  <span className="text-sf-warning shrink-0">&#8226;</span>
                  {rec}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </section>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="7" fill="var(--color-sf-success-light)" />
      <path d="M4 7l2 2 4-4" stroke="var(--color-sf-success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="7" fill="var(--color-sf-error-light)" />
      <path d="M5 5l4 4M9 5l-4 4" stroke="var(--color-sf-error)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
