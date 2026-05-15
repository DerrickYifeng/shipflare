import { Sparkline } from '@/components/admin/sparkline';
import type { DailyActivity } from '../_queries/daily';

const METRICS: Array<{ key: keyof Omit<DailyActivity, 'days'>; label: string }> = [
  { key: 'waitlistSignups', label: 'Signups' },
  { key: 'signins', label: 'Sign-ins' },
  { key: 'scans', label: 'Scans' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'postsPublished', label: 'Published' },
  { key: 'approvals', label: 'Approvals' },
];

export function SparkRow({ daily }: { daily: DailyActivity }) {
  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 500, margin: '0 0 16px' }}>
        Daily activity — last 30 days
      </h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, 1fr)',
          gap: 12,
        }}
      >
        {METRICS.map((m) => {
          const values = daily[m.key];
          const today = values[values.length - 1] ?? 0;
          const total = values.reduce((a, b) => a + b, 0);
          return (
            <div
              key={m.key}
              style={{
                padding: 12,
                background: 'var(--sf-bg-tertiary)',
                borderRadius: 6,
              }}
            >
              <div style={{ fontSize: 11, color: 'var(--sf-fg-3)' }}>{m.label}</div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  margin: '4px 0 6px',
                }}
              >
                <span style={{ fontSize: 18, fontWeight: 600 }}>{today}</span>
                <span style={{ fontSize: 11, color: 'var(--sf-fg-3)' }}>{total} 30d</span>
              </div>
              <Sparkline values={values} width={120} height={20} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
