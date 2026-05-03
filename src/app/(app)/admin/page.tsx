import Link from 'next/link';

/**
 * /admin — index of admin tools. Auth gating is handled by
 * `(app)/admin/layout.tsx`; if the visitor isn't an admin the
 * layout returns a 404 before this page renders.
 */
const TOOLS: Array<{ href: string; title: string; blurb: string }> = [
  {
    href: '/admin/invites',
    title: 'Design partner invites',
    blurb:
      'Manage allowlisted emails and per-partner activity. Add or revoke invites, see who has actually signed up.',
  },
  {
    href: '/admin/team-runs',
    title: 'Team runs',
    blurb:
      'Read-only history of every team_run across the system. Filter by status, team, cost, or window.',
  },
];

export default function AdminIndexPage() {
  return (
    <div>
      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'grid',
          gap: 16,
        }}
      >
        {TOOLS.map((t) => (
          <li
            key={t.href}
            style={{
              border: '1px solid var(--sf-border-1)',
              borderRadius: 6,
              padding: 20,
            }}
          >
            <Link
              href={t.href}
              style={{
                color: 'var(--sf-link, var(--sf-fg-1))',
                textDecoration: 'none',
                fontSize: 16,
                fontWeight: 500,
              }}
            >
              {t.title} →
            </Link>
            <p
              style={{
                margin: '6px 0 0',
                fontSize: 13,
                color: 'var(--sf-fg-3)',
                lineHeight: 1.5,
              }}
            >
              {t.blurb}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
