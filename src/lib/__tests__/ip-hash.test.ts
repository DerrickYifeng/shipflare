import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('hashIp', () => {
  const ORIGINAL_SALT = process.env.IP_HASH_SALT;

  beforeEach(() => {
    vi.resetModules();
    process.env.IP_HASH_SALT = 'test-salt-deterministic';
  });

  afterEach(() => {
    process.env.IP_HASH_SALT = ORIGINAL_SALT;
  });

  it('returns a hex string of length 64 (sha256) for a normal IP', async () => {
    const { hashIp } = await import('../ip-hash');
    const result = hashIp('203.0.113.42');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input + salt → same output', async () => {
    const { hashIp } = await import('../ip-hash');
    expect(hashIp('203.0.113.42')).toBe(hashIp('203.0.113.42'));
  });

  it('differs when salt differs', async () => {
    const { hashIp: hash1 } = await import('../ip-hash');
    const a = hash1('203.0.113.42');
    process.env.IP_HASH_SALT = 'different-salt';
    vi.resetModules();
    const { hashIp: hash2 } = await import('../ip-hash');
    const b = hash2('203.0.113.42');
    expect(a).not.toBe(b);
  });

  it('returns null when IP_HASH_SALT is missing', async () => {
    delete process.env.IP_HASH_SALT;
    const { hashIp } = await import('../ip-hash');
    expect(hashIp('203.0.113.42')).toBeNull();
  });

  it('returns null when IP is "unknown" sentinel', async () => {
    const { hashIp } = await import('../ip-hash');
    expect(hashIp('unknown')).toBeNull();
  });

  it('returns null for empty string ip', async () => {
    const { hashIp } = await import('../ip-hash');
    expect(hashIp('')).toBeNull();
  });

  it('returns null for whitespace-only ip', async () => {
    const { hashIp } = await import('../ip-hash');
    expect(hashIp('   ')).toBeNull();
  });
});
