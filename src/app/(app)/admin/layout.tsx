import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { auth } from '@/lib/auth';
import { isAdminEmail } from '@/lib/admin';

/**
 * Admin-scope layout. Rejects non-admin users with a plain 404 rather
 * than a 403 so the existence of /admin/* isn't advertised publicly.
 * ADMIN_EMAILS env var lists the allowlisted emails (comma-separated,
 * case-insensitive).
 */
export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) {
    notFound();
  }

  return (
    <section
      style={{
        padding: '32px 40px',
        maxWidth: 1200,
        margin: '0 auto',
      }}
    >
      <header
        style={{
          borderBottom: '1px solid var(--sf-border-1)',
          paddingBottom: 20,
          marginBottom: 28,
        }}
      >
        <div
          style={{
            fontSize: 11,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--sf-fg-3)',
            marginBottom: 6,
          }}
        >
          Admin
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: 24,
            fontWeight: 500,
            letterSpacing: '-0.4px',
            color: 'var(--sf-fg-1)',
          }}
        >
          Observability
        </h1>
      </header>
      {children}
    </section>
  );
}
