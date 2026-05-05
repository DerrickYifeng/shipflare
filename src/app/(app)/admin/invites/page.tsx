import { desc, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { allowedEmails, users } from '@/lib/db/schema';
import { getPartnerActivityCounts } from '@/lib/admin/partner-activity';
import { InviteForm } from './_components/invite-form';
import { RevokeButton } from './_components/revoke-button';
import { NoteCell } from './_components/note-cell';

/**
 * /admin/invites — design-partner allowlist management.
 *
 * Auth is gated by `(app)/admin/layout.tsx` (ADMIN_EMAILS env var) — it
 * 404s non-admins so the existence of this page isn't advertised. The
 * server actions in `./actions.ts` re-check via `requireAdmin()`.
 *
 * Joins `users` so we can show whether each invitee has actually
 * signed up + when they last logged in. The join is on lower(email)
 * for case-safety.
 */
export default async function AdminInvitesPage() {
  const rows = await db
    .select({
      email: allowedEmails.email,
      invitedAt: allowedEmails.invitedAt,
      invitedBy: allowedEmails.invitedBy,
      note: allowedEmails.note,
      revokedAt: allowedEmails.revokedAt,
      hasUser: sql<boolean>`${users.id} IS NOT NULL`,
      userId: users.id,
      lastLoginAt: users.lastLoginAt,
    })
    .from(allowedEmails)
    .leftJoin(users, sql`LOWER(${users.email}) = ${allowedEmails.email}`)
    .orderBy(desc(allowedEmails.invitedAt));

  // Batch-fetch 7-day activity for all registered partners.
  const userIds = rows
    .map((r) => r.userId)
    .filter((id): id is string => id !== null);
  const activity = await getPartnerActivityCounts(userIds);

  return (
    <div>
      <h2
        style={{
          margin: '0 0 8px',
          fontSize: 18,
          fontWeight: 500,
          color: 'var(--sf-fg-1)',
        }}
      >
        Design partner invites
      </h2>
      <p style={{ marginTop: 0, fontSize: 13, color: 'var(--sf-fg-3)' }}>
        Manage allowlisted emails. Sign-in is rejected for any GitHub email not
        listed here (or matching <code>SUPER_ADMIN_EMAIL</code>).
      </p>

      <InviteForm />

      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 13,
        }}
      >
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--sf-fg-3)' }}>
            <Th>Email</Th>
            <Th>Note</Th>
            <Th>Invited</Th>
            <Th>Status</Th>
            <Th>Last login</Th>
            <Th align="right">Posts 7d</Th>
            <Th align="right">Replies 7d</Th>
            <Th align="right">Scans 7d</Th>
            <Th align="right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isRevoked = row.revokedAt !== null;
            const hasJoined = row.hasUser;
            const counts = row.userId ? activity.get(row.userId) : null;
            return (
              <tr
                key={row.email}
                style={{ borderTop: '1px solid var(--sf-border-1)' }}
              >
                <Td>
                  <div style={{ fontFamily: 'var(--sf-font-mono, monospace)' }}>
                    {row.email}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--sf-fg-4)' }}>
                    by {row.invitedBy}
                  </div>
                </Td>
                <Td>
                  <NoteCell email={row.email} initial={row.note} />
                </Td>
                <Td>{formatDate(row.invitedAt)}</Td>
                <Td>
                  <StatusPill
                    state={
                      isRevoked
                        ? 'revoked'
                        : hasJoined
                          ? 'joined'
                          : 'pending'
                    }
                  />
                </Td>
                <Td>
                  {row.lastLoginAt ? formatDate(row.lastLoginAt) : '—'}
                </Td>
                <Td align="right">{formatCount(counts?.posts7d)}</Td>
                <Td align="right">{formatCount(counts?.replies7d)}</Td>
                <Td align="right">{formatCount(counts?.scans7d)}</Td>
                <Td align="right">
                  {isRevoked ? (
                    <span style={{ fontSize: 11, color: 'var(--sf-fg-4)' }}>
                      revoked {formatDate(row.revokedAt!)}
                    </span>
                  ) : (
                    <RevokeButton email={row.email} />
                  )}
                </Td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={9}
                style={{
                  padding: 24,
                  textAlign: 'center',
                  color: 'var(--sf-fg-4)',
                }}
              >
                No invites yet. Add the first design partner above.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      style={{
        padding: '8px 10px',
        fontWeight: 500,
        fontSize: 11,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        textAlign: align,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <td
      style={{
        padding: '10px',
        verticalAlign: 'top',
        textAlign: align,
        color: 'var(--sf-fg-1)',
      }}
    >
      {children}
    </td>
  );
}

function StatusPill({ state }: { state: 'pending' | 'joined' | 'revoked' }) {
  const palette: Record<typeof state, { bg: string; fg: string; label: string }> = {
    pending: { bg: 'rgba(180,180,180,0.12)', fg: 'var(--sf-fg-3)', label: 'pending' },
    joined: { bg: 'rgba(80,200,120,0.14)', fg: '#2ea043', label: 'joined' },
    revoked: { bg: 'rgba(220,80,80,0.12)', fg: '#c0392b', label: 'revoked' },
  };
  const { bg, fg, label } = palette[state];
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 10,
        background: bg,
        color: fg,
        fontSize: 11,
        fontWeight: 500,
      }}
    >
      {label}
    </span>
  );
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function formatCount(n: number | undefined): string {
  if (n === undefined) return '—';
  return n === 0 ? '0' : String(n);
}
