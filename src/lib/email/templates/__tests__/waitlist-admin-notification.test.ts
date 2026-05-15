import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { waitlistAdminNotification } from '../waitlist-admin-notification';

describe('waitlistAdminNotification', () => {
  const ORIG_ADMIN = process.env.SUPER_ADMIN_EMAIL;
  const ORIG_APPURL = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    process.env.SUPER_ADMIN_EMAIL = 'founder@shipflare.app';
    process.env.NEXT_PUBLIC_APP_URL = 'https://shipflare.app';
  });

  afterEach(() => {
    if (ORIG_ADMIN === undefined) delete process.env.SUPER_ADMIN_EMAIL;
    else process.env.SUPER_ADMIN_EMAIL = ORIG_ADMIN;
    if (ORIG_APPURL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = ORIG_APPURL;
  });

  it('addresses SUPER_ADMIN_EMAIL', () => {
    process.env.SUPER_ADMIN_EMAIL = 'founder@shipflare.app';
    const email = waitlistAdminNotification({
      email: 'newuser@example.com',
      useCase: 'building a SaaS',
      referer: 'denied',
    });
    expect(email.to).toBe('founder@shipflare.app');
  });

  it('includes email, source, and use case in the text body', () => {
    const email = waitlistAdminNotification({
      email: 'newuser@example.com',
      useCase: 'building a SaaS',
      referer: 'denied',
    });
    expect(email.text).toContain('newuser@example.com');
    expect(email.text).toContain('denied');
    expect(email.text).toContain('building a SaaS');
  });

  it('renders "(none)" for null use case', () => {
    const email = waitlistAdminNotification({
      email: 'newuser@example.com',
      useCase: null,
      referer: 'landing',
    });
    expect(email.text).toContain('Use case: (none)');
  });

  it('renders "(none)" for null referer', () => {
    const email = waitlistAdminNotification({
      email: 'newuser@example.com',
      useCase: null,
      referer: null,
    });
    expect(email.text).toContain('Source: (none)');
  });

  it('includes the admin review URL', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://shipflare.app';
    const email = waitlistAdminNotification({
      email: 'newuser@example.com',
      useCase: null,
      referer: null,
    });
    expect(email.text).toContain('https://shipflare.app/admin/invites?tab=waitlist');
  });

  it('subject line starts with [ShipFlare]', () => {
    const email = waitlistAdminNotification({
      email: 'newuser@example.com',
      useCase: null,
      referer: null,
    });
    expect(email.subject).toMatch(/^\[ShipFlare\]/);
  });

  it('throws when SUPER_ADMIN_EMAIL is not configured', () => {
    delete process.env.SUPER_ADMIN_EMAIL;
    expect(() =>
      waitlistAdminNotification({
        email: 'newuser@example.com',
        useCase: null,
        referer: null,
      }),
    ).toThrow('SUPER_ADMIN_EMAIL is not configured');
  });
});
