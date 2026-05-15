import type { UserRow } from '../_queries/users';

const STATUS_STYLE: Record<UserRow['status'], React.CSSProperties> = {
  active: { background: '#1f7a3a', color: '#fff' },
  dormant: { background: '#9a7a1f', color: '#fff' },
  lost: { background: '#7a1f1f', color: '#fff' },
  stalled: { background: '#555', color: '#fff' },
};

const STATUS_LABEL: Record<UserRow['status'], string> = {
  active: '🟢 active',
  dormant: '🟡 dormant',
  lost: '🔴 lost',
  stalled: '⚪ stalled',
};

export function UserTable({ rows }: { rows: UserRow[] }) {
  return (
    <div>
      <h3 style={{ fontSize: 14, fontWeight: 500, margin: '0 0 16px' }}>
        Users — last 30 days
      </h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: 'var(--sf-fg-3)' }}>
            <th style={th}>Email</th>
            <th style={th}>Signed up</th>
            <th style={th}>Last seen</th>
            <th style={{ ...th, textAlign: 'right' }}>Scans 7d</th>
            <th style={{ ...th, textAlign: 'right' }}>Replies 7d</th>
            <th style={{ ...th, textAlign: 'right' }}>Posts 7d</th>
            <th style={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.userId} style={{ borderTop: '1px solid var(--sf-border)' }}>
              <td style={td}>{r.email}</td>
              <td style={td}>{r.createdAt.toLocaleDateString()}</td>
              <td style={td}>
                {r.lastLoginAt ? r.lastLoginAt.toLocaleDateString() : '—'}
              </td>
              <td style={{ ...td, textAlign: 'right' }}>{r.scans7d}</td>
              <td style={{ ...td, textAlign: 'right' }}>{r.replies7d}</td>
              <td style={{ ...td, textAlign: 'right' }}>{r.posts7d}</td>
              <td style={td}>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    fontSize: 11,
                    ...STATUS_STYLE[r.status],
                  }}
                >
                  {STATUS_LABEL[r.status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const th: React.CSSProperties = {
  padding: '6px 8px',
  textAlign: 'left',
  fontWeight: 500,
};
const td: React.CSSProperties = { padding: '6px 8px' };
