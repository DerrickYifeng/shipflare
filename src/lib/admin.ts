// Admin authorization helper.
//
// We don't have a roles column on `users`; admin access is gated via a
// comma-separated `ADMIN_EMAILS` env var. When unset, the admin surface
// is effectively closed — good default for a new deployment.
//
// Used by /admin/* pages and API routes — centralize here so adding
// alternate auth (session.role, oauth claim, etc.) is one change.

function parseAllowlist(): Set<string> {
  const raw = (process.env.ADMIN_EMAILS ?? '').trim();
  if (raw === '') return new Set();
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
}

/**
 * Returns true iff the given email is on the admin allowlist. Lookup is
 * case-insensitive. Called by admin page-level auth gates.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allow = parseAllowlist();
  return allow.has(email.toLowerCase());
}

/**
 * Server-side admin gate for server actions. Layouts already gate via
 * `(app)/admin/layout.tsx`, but server actions execute outside of the
 * layout tree — they MUST call this before mutating anything.
 *
 * Returns the admin's normalized email on success. Throws on rejection
 * so the action exits with an error response (Next.js shows the user
 * the same not-found page as direct nav).
 */
export async function requireAdmin(): Promise<string> {
  const { auth } = await import('@/lib/auth');
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!isAdminEmail(email)) {
    // Same UX as the layout — opaque rather than 403.
    throw new Error('not_found');
  }
  return email!.toLowerCase();
}
