import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  // 64 hex chars = 32 bytes, enough for AES-256.
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

// Imported after env is set so getKey() doesn't throw at module load.
const mod = await import('../index');

describe('encryption helpers', () => {
  describe('encrypt / decrypt round-trip', () => {
    it('recovers the plaintext', () => {
      const ct = mod.encrypt('gho_abc123DEF');
      expect(mod.decrypt(ct)).toBe('gho_abc123DEF');
    });

    it('produces a different ciphertext on every call (random IV)', () => {
      const a = mod.encrypt('x');
      const b = mod.encrypt('x');
      expect(a).not.toBe(b);
      expect(mod.decrypt(a)).toBe('x');
      expect(mod.decrypt(b)).toBe('x');
    });

    it('rejects ciphertext tampered under the auth tag', () => {
      const ct = mod.encrypt('payload');
      // Flip one bit in the ciphertext section.
      const parts = ct.split(':');
      const tampered =
        parts[0] +
        ':' +
        parts[1] +
        ':' +
        parts[2]!.replace(/^./, (c) => (c === '0' ? '1' : '0'));
      expect(() => mod.decrypt(tampered)).toThrow();
    });
  });

  describe('isEncrypted', () => {
    it('true for freshly-encrypted values', () => {
      expect(mod.isEncrypted(mod.encrypt('hello'))).toBe(true);
    });

    it('false for obvious plaintext GitHub tokens', () => {
      expect(mod.isEncrypted('gho_1234567890abcdef1234567890abcdef12345678')).toBe(false);
      expect(mod.isEncrypted('ghp_xyz')).toBe(false);
      expect(mod.isEncrypted('')).toBe(false);
    });

    it('false for random 2-colon strings that are not hex', () => {
      expect(mod.isEncrypted('hello:world:again')).toBe(false);
    });

    it('false when IV or tag segment has wrong length', () => {
      const ct = mod.encrypt('x');
      const [iv, tag, ctPart] = ct.split(':');
      const shortIv = iv!.slice(0, -2);
      expect(mod.isEncrypted(`${shortIv}:${tag}:${ctPart}`)).toBe(false);
    });
  });

  describe('maybeDecrypt', () => {
    it('decrypts encrypted input', () => {
      const ct = mod.encrypt('token-xyz');
      expect(mod.maybeDecrypt(ct)).toBe('token-xyz');
    });

    it('returns plaintext as-is (lazy-migration fallback)', () => {
      expect(mod.maybeDecrypt('gho_legacyPlaintextToken')).toBe('gho_legacyPlaintextToken');
    });

    it('passes through null/undefined', () => {
      expect(mod.maybeDecrypt(null)).toBeNull();
      expect(mod.maybeDecrypt(undefined)).toBeNull();
    });
  });

  describe('encryptNullable', () => {
    it('returns null for null/undefined', () => {
      expect(mod.encryptNullable(null)).toBeNull();
      expect(mod.encryptNullable(undefined)).toBeNull();
    });

    it('encrypts a string and the value round-trips', () => {
      const ct = mod.encryptNullable('t');
      expect(ct).not.toBeNull();
      expect(mod.isEncrypted(ct!)).toBe(true);
      expect(mod.decrypt(ct!)).toBe('t');
    });
  });
});
