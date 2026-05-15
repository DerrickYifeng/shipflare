import type { FunnelCounts } from '../_queries/funnel';

const STAGES: Array<{ key: keyof FunnelCounts; label: string }> = [
  { key: 'waitlistSignups', label: 'Waitlist signups' },
  { key: 'approvedAllowlisted', label: 'Approved → allowlisted' },
  { key: 'signedUp', label: 'Signed up' },
  { key: 'ranFirstScan', label: 'Ran first scan' },
  { key: 'publishedFirstPost', label: 'Published first post' },
];

export function Funnel({ counts }: { counts: FunnelCounts }) {
  const max = Math.max(...STAGES.map((s) => counts[s.key]), 1);

  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 500, marginBottom: 16 }}>
        Alpha funnel — last 30 days
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {STAGES.map((s, i) => {
          const value = counts[s.key];
          const widthPct = (value / max) * 100;
          const prev = i > 0 ? counts[STAGES[i - 1].key] : null;
          const convPct =
            prev !== null && prev > 0 ? Math.round((value / prev) * 100) : null;

          return (
            <div key={s.key}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  marginBottom: 4,
                  color: 'var(--sf-fg-2)',
                }}
              >
                <span>{s.label}</span>
                <span>
                  <strong style={{ color: 'var(--sf-fg-1)' }}>{value}</strong>
                  {convPct !== null ? (
                    <span style={{ marginLeft: 8, color: 'var(--sf-fg-3)' }}>
                      {convPct}%
                    </span>
                  ) : null}
                </span>
              </div>
              <div
                style={{
                  height: 8,
                  background: 'var(--sf-bg-tertiary)',
                  borderRadius: 4,
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${widthPct}%`,
                    background: 'var(--sf-accent)',
                    borderRadius: 4,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
