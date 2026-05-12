import { and, isNull, isNotNull, desc, asc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { waitlistSignups } from '@/lib/db/schema';
import { WaitlistActionsButtons } from './waitlist-actions-buttons';

type Status = 'pending' | 'approved' | 'dismissed';

export async function WaitlistTab({ status }: { status: Status }) {
  const where =
    status === 'pending'
      ? and(
          isNull(waitlistSignups.approvedAt),
          isNull(waitlistSignups.dismissedAt),
        )
      : status === 'approved'
        ? isNotNull(waitlistSignups.approvedAt)
        : isNotNull(waitlistSignups.dismissedAt);

  const orderBy =
    status === 'pending'
      ? asc(waitlistSignups.createdAt)
      : desc(waitlistSignups.createdAt);

  const rows = await db
    .select({
      id: waitlistSignups.id,
      email: waitlistSignups.email,
      useCase: waitlistSignups.useCase,
      referer: waitlistSignups.referer,
      createdAt: waitlistSignups.createdAt,
      approvedAt: waitlistSignups.approvedAt,
      approvedBy: waitlistSignups.approvedBy,
      dismissedAt: waitlistSignups.dismissedAt,
      dismissedBy: waitlistSignups.dismissedBy,
    })
    .from(waitlistSignups)
    .where(where)
    .orderBy(orderBy);

  if (rows.length === 0) {
    const emptyCopy =
      status === 'pending'
        ? 'No pending waitlist signups.'
        : status === 'approved'
          ? 'No approved signups yet.'
          : 'No dismissed signups.';
    return (
      <p style={{ color: 'var(--sf-fg-3)', fontSize: 13, padding: '24px 0' }}>
        {emptyCopy}
      </p>
    );
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ textAlign: 'left', color: 'var(--sf-fg-3)' }}>
          <th style={th}>Email</th>
          <th style={th}>Use case</th>
          <th style={th}>Source</th>
          <th style={th}>Submitted</th>
          {status === 'pending' && (
            <th style={{ ...th, textAlign: 'right' }}>Actions</th>
          )}
          {status === 'approved' && <th style={th}>Approved by</th>}
          {status === 'dismissed' && <th style={th}>Dismissed by</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderTop: '1px solid var(--sf-border-1)' }}>
            <td style={td}>{r.email}</td>
            <td style={td}>{r.useCase ?? '—'}</td>
            <td style={td}>{r.referer ?? '—'}</td>
            <td style={td}>{r.createdAt.toLocaleDateString()}</td>
            {status === 'pending' && (
              <td style={td}>
                <WaitlistActionsButtons id={r.id} />
              </td>
            )}
            {status === 'approved' && <td style={td}>{r.approvedBy ?? '—'}</td>}
            {status === 'dismissed' && (
              <td style={td}>{r.dismissedBy ?? '—'}</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const th: React.CSSProperties = { padding: '8px 6px', fontWeight: 500 };
const td: React.CSSProperties = { padding: '8px 6px' };
