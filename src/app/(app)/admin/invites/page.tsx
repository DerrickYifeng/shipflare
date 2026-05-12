import Link from 'next/link';
import { desc, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { allowedEmails, users, waitlistSignups } from '@/lib/db/schema';
import { getPartnerActivityCounts } from '@/lib/admin/partner-activity';
import { InviteForm } from './_components/invite-form';
import { RevokeButton } from './_components/revoke-button';
import { NoteCell } from './_components/note-cell';
import { WaitlistTab } from './_components/waitlist-tab';

/**
 * /admin/invites — design-partner allowlist management.
 *
 * Auth is gated by `(app)/admin/layout.tsx` (ADMIN_EMAILS env var) — it
 * 404s non-admins so the existence of this page isn't advertised. The
 * server actions in `./actions.ts` re-check via `requireAdmin()`.
 */

interface PageProps {
  searchParams: Promise<{ tab?: string; status?: string }>;
}

export default async function AdminInvitesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tab = sp.tab === 'waitlist' ? 'waitlist' : 'invites';
  const status =
    sp.status === 'approved' || sp.status === 'dismissed'
      ? sp.status
      : 'pending';

  // Counts for the badges — runs unconditionally so both tabs show counts.
  const [{ pending, approved, dismissed }] = await db
    .select({
      pending: sql<number>`count(*) filter (where approved_at is null and dismissed_at is null)`,
      approved: sql<number>`count(*) filter (where approved_at is not null)`,
      dismissed: sql<number>`count(*) filter (where dismissed_at is not null)`,
    })
    .from(waitlistSignups);

  return (
    <div>
      <h2
        style={{
          margin: '0 0 12px',
          fontSize: 18,
          fontWeight: 500,
          color: 'var(--sf-fg-1)',
        }}
      >
        Design partner invites
      </h2>

      {/* Tab strip */}
      <div
        style={{
          display: 'flex',
          gap: 24,
          borderBottom: '1px solid var(--sf-border-1)',
          marginBottom: 24,
        }}
      >
        <TabLink href="/admin/invites" active={tab === 'invites'}>
          Invites
        </TabLink>
        <TabLink href="/admin/invites?tab=waitlist" active={tab === 'waitlist'}>
          Waitlist {Number(pending) > 0 ? `(${pending})` : ''}
        </TabLink>
      </div>

      {tab === 'invites' ? (
        <InvitesTabContent />
      ) : (
        <>
          {/* Status filter chips */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <FilterChip
              href="/admin/invites?tab=waitlist&status=pending"
              active={status === 'pending'}
            >
              Pending ({pending})
            </FilterChip>
            <FilterChip
              href="/admin/invites?tab=waitlist&status=approved"
              active={status === 'approved'}
            >
              Approved ({approved})
            </FilterChip>
            <FilterChip
              href="/admin/invites?tab=waitlist&status=dismissed"
              active={status === 'dismissed'}
            >
              Dismissed ({dismissed})
            </FilterChip>
          </div>
          <WaitlistTab status={status} />
        </>
      )}
    </div>
  );
}

function TabLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      style={{
        padding: '10px 0',
        borderBottom: active
          ? '2px solid var(--sf-accent)'
          : '2px solid transparent',
        color: active ? 'var(--sf-fg-1)' : 'var(--sf-fg-3)',
        textDecoration: 'none',
        fontSize: 14,
        fontWeight: active ? 600 : 400,
        marginBottom: -1,
      }}
    >
      {children}
    </Link>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      style={{
        padding: '4px 12px',
        borderRadius: 999,
        background: active ? 'var(--sf-bg-tertiary)' : 'transparent',
        color: active ? 'var(--sf-fg-1)' : 'var(--sf-fg-3)',
        border: '1px solid var(--sf-border-1)',
        fontSize: 12,
        textDecoration: 'none',
      }}
    >
      {children}
    </Link>
  );
}

async function InvitesTabContent() {
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
                      isRevoked ? 'revoked' : hasJoined ? 'joined' : 'pending'
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
  const palette: Record<typeof state, { bg: string; fg: string; label: string }> =
    {
      pending: {
        bg: 'rgba(180,180,180,0.12)',
        fg: 'var(--sf-fg-3)',
        label: 'pending',
      },
      joined: {
        bg: 'rgba(80,200,120,0.14)',
        fg: '#2ea043',
        label: 'joined',
      },
      revoked: {
        bg: 'rgba(220,80,80,0.12)',
        fg: '#c0392b',
        label: 'revoked',
      },
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
