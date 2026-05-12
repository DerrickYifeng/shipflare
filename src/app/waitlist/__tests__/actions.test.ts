import { describe, it, expect, beforeEach, vi } from 'vitest';

const { insertReturn, onConflictDoUpdate, values, insertFn } = vi.hoisted(() => {
  const insertReturn = vi.fn();
  const onConflictDoUpdate = vi.fn(() => ({ returning: insertReturn }));
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insertFn = vi.fn(() => ({ values }));
  return { insertReturn, onConflictDoUpdate, values, insertFn };
});

vi.mock('@/lib/db', () => ({
  db: { insert: insertFn },
}));

vi.mock('@/lib/rate-limit', () => ({
  acquireRateLimit: vi.fn(),
}));

vi.mock('@/lib/email', () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true, id: 'em1' }),
}));

vi.mock('@/lib/email/templates/waitlist-admin-notification', () => ({
  waitlistAdminNotification: vi.fn((i) => ({
    to: 'admin@x',
    subject: 's',
    text: `T:${i.email}`,
  })),
}));

vi.mock('@/lib/ip-hash', () => ({
  hashIp: vi.fn(() => 'abc123'),
}));

vi.mock('next/headers', () => ({
  headers: () => new Headers({ 'x-forwarded-for': '203.0.113.42' }),
}));

import { joinWaitlist } from '../actions';
import { acquireRateLimit } from '@/lib/rate-limit';
import { sendEmail } from '@/lib/email';

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

const NOW = new Date('2026-05-11T00:00:00Z');

describe('joinWaitlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acquireRateLimit).mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 0,
    });
    insertReturn.mockResolvedValue([
      { id: 'w1', createdAt: NOW, updatedAt: NOW },
    ]);
  });

  it('rejects invalid email with a friendly error', async () => {
    const result = await joinWaitlist(undefined as never, fd({ email: 'not-an-email' }));
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(insertFn).not.toHaveBeenCalled();
  });

  it('returns success silently when honeypot is filled (no DB write, no email)', async () => {
    const result = await joinWaitlist(undefined as never, fd({
      email: 'real@example.com',
      company: 'spam-bot',
    }));
    expect(result.ok).toBe(true);
    expect(insertFn).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('returns rate-limit error when acquireRateLimit denies', async () => {
    vi.mocked(acquireRateLimit).mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 30,
    });
    const result = await joinWaitlist(undefined as never, fd({ email: 'a@b.com' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too many/i);
  });

  it('upserts a new row and sends admin notification', async () => {
    await joinWaitlist(undefined as never, fd({
      email: 'NewUser@Example.COM',
      useCase: '  building a SaaS  ',
      referer: 'landing',
    }));

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      email: 'newuser@example.com',         // normalized
      useCase: 'building a SaaS',           // trimmed
      referer: 'landing',
      ipHash: 'abc123',
    }));
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('skips admin notification when the row already existed', async () => {
    const past = new Date(NOW.getTime() - 10 * 60 * 1000); // 10 min ago
    insertReturn.mockResolvedValueOnce([
      { id: 'w1', createdAt: past, updatedAt: NOW },
    ]);
    const result = await joinWaitlist(undefined as never, fd({ email: 'a@b.com' }));
    expect(result.ok).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('passes null for useCase when the field is empty/whitespace', async () => {
    await joinWaitlist(undefined as never, fd({
      email: 'a@b.com',
      useCase: '   ',
    }));
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      useCase: null,
    }));
  });

  it('returns ok:true even when admin notification throws (misconfigured env)', async () => {
    // waitlistAdminNotification can throw if SUPER_ADMIN_EMAIL is unset.
    // The signup row is already committed at that point — the action
    // must NOT surface the failure to the user.
    const { waitlistAdminNotification } = await import(
      '@/lib/email/templates/waitlist-admin-notification'
    );
    vi.mocked(waitlistAdminNotification).mockImplementationOnce(() => {
      throw new Error('SUPER_ADMIN_EMAIL not configured');
    });

    const result = await joinWaitlist(
      undefined as never,
      fd({ email: 'newuser@example.com' }),
    );

    expect(result.ok).toBe(true);
    expect(values).toHaveBeenCalled();  // row was inserted
  });
});
