import { describe, it, expect, afterEach } from 'vitest';
import { waitlistApproved } from '../waitlist-approved';

describe('waitlistApproved', () => {
  const ORIG_APPURL = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    if (ORIG_APPURL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = ORIG_APPURL;
  });

  it('addresses the applicant', () => {
    const email = waitlistApproved({ email: 'newuser@example.com' });
    expect(email.to).toBe('newuser@example.com');
  });

  it('includes the applicant email in the body', () => {
    const email = waitlistApproved({ email: 'newuser@example.com' });
    expect(email.text).toContain('newuser@example.com');
  });

  it('includes the app URL', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://shipflare.app';
    const email = waitlistApproved({ email: 'newuser@example.com' });
    expect(email.text).toContain('https://shipflare.app');
  });

  it('subject line is friendly and short', () => {
    const email = waitlistApproved({ email: 'newuser@example.com' });
    expect(email.subject.length).toBeLessThan(80);
    expect(email.subject).toMatch(/alpha|invite|in/i);
  });
});
