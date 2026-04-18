import { describe, it, expect, beforeAll } from 'vitest';
import type { AdapterAccount } from 'next-auth/adapters';

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

const { encryptAccount, decryptAccount, ENCRYPTED_ACCOUNT_FIELDS } = await import(
  '../account-encryption'
);
const { decrypt, isEncrypted } = await import('@/lib/encryption');

function makeAccount(overrides: Partial<AdapterAccount> = {}): AdapterAccount {
  return {
    userId: 'u-1',
    type: 'oauth',
    provider: 'github',
    providerAccountId: '12345',
    access_token: 'gho_plaintext_access',
    refresh_token: 'gho_plaintext_refresh',
    id_token: 'eyJhbGciOi...',
    token_type: 'bearer',
    scope: 'read:user user:email',
    expires_at: null as unknown as number,
    session_state: null as unknown as string,
    ...overrides,
  };
}

describe('encryptAccount', () => {
  it('encrypts access_token, refresh_token, and id_token only', () => {
    const acc = makeAccount();
    const encrypted = encryptAccount(acc);

    for (const field of ENCRYPTED_ACCOUNT_FIELDS) {
      const v = (encrypted as Record<string, unknown>)[field];
      expect(typeof v).toBe('string');
      expect(isEncrypted(v as string)).toBe(true);
      expect(decrypt(v as string)).toBe((acc as Record<string, unknown>)[field]);
    }

    // Non-secret fields are untouched.
    expect(encrypted.userId).toBe(acc.userId);
    expect(encrypted.provider).toBe(acc.provider);
    expect(encrypted.providerAccountId).toBe(acc.providerAccountId);
    expect(encrypted.scope).toBe(acc.scope);
    expect(encrypted.token_type).toBe(acc.token_type);
  });

  it('leaves null/undefined token fields alone (does not insert empty strings)', () => {
    const acc = makeAccount({ refresh_token: undefined, id_token: null as unknown as string });
    const encrypted = encryptAccount(acc);
    expect(encrypted.refresh_token).toBeUndefined();
    expect(encrypted.id_token).toBeNull();
    expect(isEncrypted(encrypted.access_token!)).toBe(true);
  });

  it('does not mutate the input', () => {
    const acc = makeAccount();
    const snapshot = { ...acc };
    encryptAccount(acc);
    expect(acc).toEqual(snapshot);
  });
});

describe('decryptAccount', () => {
  it('round-trips encryptAccount', () => {
    const acc = makeAccount();
    const roundTripped = decryptAccount(encryptAccount(acc));
    expect(roundTripped).toEqual(acc);
  });

  it('returns legacy plaintext rows unchanged (lazy-migration fallback)', () => {
    const legacy = makeAccount();
    const result = decryptAccount(legacy);
    expect(result.access_token).toBe(legacy.access_token);
    expect(result.refresh_token).toBe(legacy.refresh_token);
    expect(result.id_token).toBe(legacy.id_token);
  });

  it('passes through null/undefined', () => {
    expect(decryptAccount(null)).toBeNull();
    expect(decryptAccount(undefined)).toBeUndefined();
  });
});
