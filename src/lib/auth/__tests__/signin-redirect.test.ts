import type { Account, Profile } from 'next-auth';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({ db: { update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })) } }));
vi.mock('@/lib/auth/allowlist', () => ({
  isEmailAllowed: vi.fn(),
  normalizeEmail: (s: string) => s.trim().toLowerCase(),
  getSuperAdminEmail: () => null,
}));

import { isEmailAllowed } from '@/lib/auth/allowlist';

async function importSignInCallback() {
  // Re-import to pick up env changes
  const mod = await import('../signin-callback');
  return mod.signInCallback;
}

describe('signIn callback redirect behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true for an allowed email', async () => {
    vi.mocked(isEmailAllowed).mockResolvedValue(true);
    const cb = await importSignInCallback();
    const result = await cb({
      user: { id: 'u1', email: 'alice@example.com' },
      account: { provider: 'github' } as Account,
      profile: { id: '12345', login: 'alice' } as Profile,
    });
    expect(result).toBe(true);
  });

  it('returns /waitlist redirect URL for a disallowed email', async () => {
    vi.mocked(isEmailAllowed).mockResolvedValue(false);
    const cb = await importSignInCallback();
    const result = await cb({
      user: { id: undefined, email: 'mallory@example.com' },
      account: { provider: 'github' } as Account,
      profile: { id: '67890', login: 'mallory' } as Profile,
    });
    expect(result).toBe(
      '/waitlist?from=denied&email=mallory%40example.com',
    );
  });

  it('returns /waitlist redirect with reason=no-email when provider gave no email', async () => {
    const cb = await importSignInCallback();
    const result = await cb({
      user: { id: undefined, email: null },
      account: { provider: 'github' } as Account,
      profile: { id: '67890', login: 'mallory' } as Profile,
    });
    expect(result).toBe('/waitlist?from=denied&reason=no-email');
  });

  it('url-encodes the email', async () => {
    vi.mocked(isEmailAllowed).mockResolvedValue(false);
    const cb = await importSignInCallback();
    const result = await cb({
      user: { id: undefined, email: 'name+tag@example.com' },
      account: { provider: 'github' } as Account,
      profile: { id: '1', login: 'x' } as Profile,
    });
    expect(result).toBe(
      '/waitlist?from=denied&email=name%2Btag%40example.com',
    );
  });
});
