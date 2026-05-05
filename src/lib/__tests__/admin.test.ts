import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// requireAdmin dynamic-imports @/lib/auth at call time to dodge cycles.
// Mock the lazy import.
const mockAuth = vi.fn();
vi.mock('@/lib/auth', () => ({
  auth: () => mockAuth(),
}));

const { isAdminEmail, requireAdmin } = await import('@/lib/admin');

describe('isAdminEmail', () => {
  const originalEnv = process.env.ADMIN_EMAILS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ADMIN_EMAILS;
    } else {
      process.env.ADMIN_EMAILS = originalEnv;
    }
  });

  it('returns false when ADMIN_EMAILS is unset', () => {
    delete process.env.ADMIN_EMAILS;
    expect(isAdminEmail('alice@example.com')).toBe(false);
  });

  it('returns false when email is null/undefined', () => {
    process.env.ADMIN_EMAILS = 'alice@example.com';
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail('')).toBe(false);
  });

  it('matches a single allowlisted email case-insensitively', () => {
    process.env.ADMIN_EMAILS = 'alice@example.com';
    expect(isAdminEmail('alice@example.com')).toBe(true);
    expect(isAdminEmail('ALICE@EXAMPLE.COM')).toBe(true);
    expect(isAdminEmail('bob@example.com')).toBe(false);
  });

  it('matches any entry in a comma-separated allowlist', () => {
    process.env.ADMIN_EMAILS =
      'alice@example.com, bob@example.com ,CAROL@EXAMPLE.COM';
    expect(isAdminEmail('alice@example.com')).toBe(true);
    expect(isAdminEmail('bob@example.com')).toBe(true);
    expect(isAdminEmail('carol@example.com')).toBe(true);
    expect(isAdminEmail('dave@example.com')).toBe(false);
  });

  it('ignores empty entries in the allowlist', () => {
    process.env.ADMIN_EMAILS = 'alice@example.com,,';
    expect(isAdminEmail('alice@example.com')).toBe(true);
    expect(isAdminEmail('')).toBe(false);
  });
});

describe('requireAdmin', () => {
  const originalEnv = process.env.ADMIN_EMAILS;

  beforeEach(() => {
    mockAuth.mockReset();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalEnv;
  });

  it('throws not_found when there is no session', async () => {
    process.env.ADMIN_EMAILS = 'alice@example.com';
    mockAuth.mockResolvedValueOnce(null);
    await expect(requireAdmin()).rejects.toThrow('not_found');
  });

  it('throws not_found when the session email is not in the allowlist', async () => {
    process.env.ADMIN_EMAILS = 'alice@example.com';
    mockAuth.mockResolvedValueOnce({ user: { email: 'stranger@example.com' } });
    await expect(requireAdmin()).rejects.toThrow('not_found');
  });

  it('returns the normalized admin email on success', async () => {
    process.env.ADMIN_EMAILS = 'Alice@Example.com';
    mockAuth.mockResolvedValueOnce({ user: { email: 'ALICE@example.com' } });
    await expect(requireAdmin()).resolves.toBe('alice@example.com');
  });
});
