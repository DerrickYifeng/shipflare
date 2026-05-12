import type { RetentionResult } from '../_queries/retention';

export function Retention({ data }: { data: RetentionResult }) {
  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 500, margin: '0 0 16px' }}>
        Retention — meaningful actions per cohort
      </h3>

      {/* D1 / D7 / D14 + Stickiness */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 12,
          marginBottom: 24,
        }}
      >
        <BigStat label="D1" value={pct(data.nDayRetention.d1)} />
        <BigStat label="D7" value={pct(data.nDayRetention.d7)} />
        <BigStat label="D14" value={pct(data.nDayRetention.d14)} />
        <BigStat
          label="DAU/WAU"
          value={data.dauWauRatio.toFixed(2)}
          caption={
            data.dauWauRatio > 0.5 ? 'sticky'
              : data.dauWauRatio > 0.2 ? 'forming'
              : 'low engagement'
          }
        />
      </div>

      {/* Cohort table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: 'var(--sf-fg-3)' }}>
            <th style={th}>Cohort</th>
            <th style={th}>Size</th>
            <th style={th}>W0</th>
            <th style={th}>W1</th>
            <th style={th}>W2</th>
            <th style={th}>W3</th>
          </tr>
        </thead>
        <tbody>
          {data.cohorts.map((c) => (
            <tr key={c.cohortStart} style={{ borderTop: '1px solid var(--sf-border)' }}>
              <td style={td}>{c.cohortStart}</td>
              <td style={td}>{c.cohortSize}</td>
              {[0, 1, 2, 3].map((wi) => {
                const count = c.weeklyRetention[wi] ?? 0;
                const ratio = c.cohortSize > 0 ? count / c.cohortSize : 0;
                return (
                  <td
                    key={wi}
                    style={{
                      ...td,
                      background: `rgba(0, 150, 200, ${ratio * 0.5})`,
                    }}
                  >
                    {c.cohortSize > 0 ? `${Math.round(ratio * 100)}%` : '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BigStat({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption?: string;
}) {
  return (
    <div style={{ padding: 12, background: 'var(--sf-bg-tertiary)', borderRadius: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--sf-fg-3)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, margin: '2px 0' }}>{value}</div>
      {caption ? (
        <div style={{ fontSize: 11, color: 'var(--sf-fg-3)' }}>{caption}</div>
      ) : null}
    </div>
  );
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

const th: React.CSSProperties = { padding: '6px 8px', textAlign: 'left', fontWeight: 500 };
const td: React.CSSProperties = { padding: '6px 8px' };
