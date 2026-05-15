import { describe, it, expect } from 'vitest';
import { waitlistThankYou } from '../waitlist-thank-you';

describe('waitlistThankYou', () => {
  it('addresses the applicant', () => {
    const email = waitlistThankYou({ email: 'newuser@example.com' });
    expect(email.to).toBe('newuser@example.com');
  });

  it('subject mentions waitlist and is under 80 chars', () => {
    const email = waitlistThankYou({ email: 'newuser@example.com' });
    expect(email.subject.length).toBeLessThan(80);
    expect(email.subject).toMatch(/waitlist|alpha/i);
  });

  it('text body acknowledges the request and sets wave-invite expectation', () => {
    const email = waitlistThankYou({ email: 'a@b.com' });
    expect(email.text).toMatch(/thanks/i);
    expect(email.text).toMatch(/waitlist/i);
    expect(email.text).toMatch(/wave/i);
  });

  it('html body is present and includes inline styles for email clients', () => {
    const email = waitlistThankYou({ email: 'a@b.com' });
    expect(email.html).toBeTruthy();
    expect(email.html).toContain('font-family');
  });

  it('tags include waitlist_thankyou kind for Resend analytics', () => {
    const email = waitlistThankYou({ email: 'a@b.com' });
    expect(email.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'kind', value: 'waitlist_thankyou' }),
      ]),
    );
  });
});
