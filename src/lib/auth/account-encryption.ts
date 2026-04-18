import type { AdapterAccount } from 'next-auth/adapters';
import { encryptNullable, maybeDecrypt } from '@/lib/encryption';

/**
 * Fields inside an `AdapterAccount` that carry OAuth secrets. We encrypt these
 * at rest so a DB snapshot alone does not grant access to a user's GitHub.
 * See CLAUDE.md → Security TODO (now resolved for the `accounts` table).
 */
export const ENCRYPTED_ACCOUNT_FIELDS = [
  'access_token',
  'refresh_token',
  'id_token',
] as const;

export function encryptAccount<T extends Partial<AdapterAccount>>(data: T): T {
  const out = { ...data } as Record<string, unknown>;
  for (const field of ENCRYPTED_ACCOUNT_FIELDS) {
    const v = out[field];
    if (typeof v === 'string') {
      out[field] = encryptNullable(v);
    }
  }
  return out as T;
}

export function decryptAccount<T extends Partial<AdapterAccount> | null | undefined>(
  data: T,
): T {
  if (!data) return data;
  const out = { ...data } as Record<string, unknown>;
  for (const field of ENCRYPTED_ACCOUNT_FIELDS) {
    const v = out[field];
    if (typeof v === 'string') {
      out[field] = maybeDecrypt(v);
    }
  }
  return out as T;
}
