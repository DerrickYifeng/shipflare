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
