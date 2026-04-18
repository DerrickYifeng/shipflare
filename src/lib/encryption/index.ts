import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 hex characters');
  }
  // Use first 32 bytes (64 hex chars) or hash if shorter
  return Buffer.from(hex.slice(0, 64).padEnd(64, '0'), 'hex');
}

/**
 * Encrypt a string using AES-256-GCM.
 * Format: iv:tag:ciphertext (all hex encoded).
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a string encrypted with encrypt().
 */
export function decrypt(encryptedString: string): string {
  const key = getKey();
  const parts = encryptedString.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted string format');
  }

  const [ivHex, tagHex, ciphertext] = parts;
  const iv = Buffer.from(ivHex!, 'hex');
  const tag = Buffer.from(tagHex!, 'hex');

  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('Invalid IV or auth tag length');
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext!, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Detects our `iv:tag:ciphertext` format cheaply, without running AES.
 * Used to route lazy-migration reads (plaintext fallback) without false positives.
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  const [iv, tag, ct] = parts;
  // iv + tag are fixed-length hex; ct is even-length hex.
  return (
    iv!.length === IV_LENGTH * 2 &&
    tag!.length === TAG_LENGTH * 2 &&
    /^[0-9a-f]+$/.test(iv!) &&
    /^[0-9a-f]+$/.test(tag!) &&
    /^[0-9a-f]*$/.test(ct!) &&
    ct!.length % 2 === 0
  );
}

export function encryptNullable(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return encrypt(value);
}

/**
 * Decrypt if the value looks encrypted; otherwise return as-is.
 * Supports lazy migration of legacy plaintext rows.
 */
export function maybeDecrypt(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!isEncrypted(value)) return value;
  return decrypt(value);
}
