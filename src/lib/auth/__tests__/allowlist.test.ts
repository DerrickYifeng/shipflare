import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory allowed_emails store + db mock
// ---------------------------------------------------------------------------

interface Row {
  email: string;
  revokedAt: Date | null;
}
const store: Row[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async (_n: number): Promise<Array<{ email: string }>> => {
            // Mirror the gate query: row exists with email match AND revokedAt IS NULL.
            const matches = store.filter(
              (r) => r.email === lastWhereEmail && r.revokedAt === null,
            );
            return matches.slice(0, _n).map((r) => ({ email: r.email }));
          },
        }),
      }),
    }),
  },
}));

// Capture the email passed to `eq(allowedEmails.email, ...)` so the
// mock above can filter against it. Real drizzle returns SQL fragments;
// we substitute pure JS state.
let lastWhereEmail = '';

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => {
      // First call is for the email; second is for revokedAt comparison.
      // We only need to capture the email value — `isNull` is a separate fn.
      if (typeof val === 'string') lastWhereEmail = val;
      return { _eq: true, val };
    },
    and: (...parts: unknown[]) => ({ _and: true, parts }),
    isNull: (col: unknown) => ({ _isNull: true, col }),
  };
});

const { normalizeEmail, getSuperAdminEmail, isEmailAllowed } = await import(
  '../allowlist'
);

beforeEach(() => {
  store.length = 0;
  lastWhereEmail = '';
});

afterEach(() => {
  delete process.env.SUPER_ADMIN_EMAIL;
});

// ---------------------------------------------------------------------------
// normalizeEmail
// ---------------------------------------------------------------------------

describe('normalizeEmail', () => {
  it('lowercases', () => {
    expect(normalizeEmail('Foo@Bar.COM')).toBe('foo@bar.com');
  });
  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  hi@x.com  ')).toBe('hi@x.com');
  });
  it('handles already-canonical', () => {
    expect(normalizeEmail('ok@example.com')).toBe('ok@example.com');
  });
  it('handles tab + newline', () => {
    expect(normalizeEmail('\tA@B.io\n')).toBe('a@b.io');
  });
});

// ---------------------------------------------------------------------------
// getSuperAdminEmail
// ---------------------------------------------------------------------------

describe('getSuperAdminEmail', () => {
  it('returns null when env var is unset', () => {
    delete process.env.SUPER_ADMIN_EMAIL;
    expect(getSuperAdminEmail()).toBeNull();
  });
  it('returns null when env var is empty/whitespace', () => {
    process.env.SUPER_ADMIN_EMAIL = '   ';
    expect(getSuperAdminEmail()).toBeNull();
  });
  it('returns the normalized email', () => {
    process.env.SUPER_ADMIN_EMAIL = '  Founder@Example.COM ';
    expect(getSuperAdminEmail()).toBe('founder@example.com');
  });
});

// ---------------------------------------------------------------------------
// isEmailAllowed
// ---------------------------------------------------------------------------

describe('isEmailAllowed', () => {
  it('rejects empty email', async () => {
    expect(await isEmailAllowed('')).toBe(false);
  });

  it('allows super admin even when allowlist table is empty', async () => {
    process.env.SUPER_ADMIN_EMAIL = 'founder@example.com';
    expect(await isEmailAllowed('founder@example.com')).toBe(true);
  });

  it('allows super admin even if their row is explicitly revoked (bug guard)', async () => {
    // If the founder accidentally revokes themselves via /admin/invites, the
    // env-var bypass MUST still let them in — otherwise self-lockout.
    process.env.SUPER_ADMIN_EMAIL = 'founder@example.com';
    store.push({ email: 'founder@example.com', revokedAt: new Date() });
    expect(await isEmailAllowed('founder@example.com')).toBe(true);
  });

  it('rejects a non-allowlisted email when SUPER_ADMIN_EMAIL is set', async () => {
    process.env.SUPER_ADMIN_EMAIL = 'founder@example.com';
    expect(await isEmailAllowed('stranger@example.com')).toBe(false);
  });

  it('allows an allowlisted (active) email', async () => {
    process.env.SUPER_ADMIN_EMAIL = 'founder@example.com';
    store.push({ email: 'partner@example.com', revokedAt: null });
    expect(await isEmailAllowed('partner@example.com')).toBe(true);
  });

  it('rejects a revoked email', async () => {
    process.env.SUPER_ADMIN_EMAIL = 'founder@example.com';
    store.push({ email: 'partner@example.com', revokedAt: new Date() });
    expect(await isEmailAllowed('partner@example.com')).toBe(false);
  });

  it('rejects a non-allowlisted email when SUPER_ADMIN_EMAIL is unset', async () => {
    // No env var, no DB row → false. (Logs a WARN but does not throw.)
    delete process.env.SUPER_ADMIN_EMAIL;
    expect(await isEmailAllowed('anybody@example.com')).toBe(false);
  });
});
