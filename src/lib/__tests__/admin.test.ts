import { describe, it, expect, afterEach } from 'vitest';
import { isAdminEmail } from '@/lib/admin';

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
