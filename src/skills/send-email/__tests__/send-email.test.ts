import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendEmailOutputSchema } from '@/agents/schemas';
import { sendEmail } from '../send';

describe('sendEmailOutputSchema', () => {
  it('accepts a sent result', () => {
    expect(() =>
      sendEmailOutputSchema.parse({
        sent: true,
        providerMessageId: 'abc-123',
        reason: 'sent',
      }),
    ).not.toThrow();
  });

  it('accepts a no-provider short-circuit', () => {
    expect(() =>
      sendEmailOutputSchema.parse({
        sent: false,
        providerMessageId: null,
        reason: 'no_provider',
      }),
    ).not.toThrow();
  });

  it('rejects an unknown reason', () => {
    expect(() =>
      sendEmailOutputSchema.parse({
        sent: false,
        providerMessageId: null,
        reason: 'timeout',
      }),
    ).toThrow();
  });
});

describe('sendEmail() runtime behaviour', () => {
  const originalKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.EMAIL_FROM;

  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  });

  afterEach(() => {
    if (originalKey !== undefined) process.env.RESEND_API_KEY = originalKey;
    if (originalFrom !== undefined) process.env.EMAIL_FROM = originalFrom;
    vi.restoreAllMocks();
  });

  it('short-circuits to no_provider when RESEND_API_KEY is unset', async () => {
    const out = await sendEmail({
      to: 'user@example.com',
      subject: 's',
      bodyText: 'b',
    });
    expect(out.sent).toBe(false);
    expect(out.reason).toBe('no_provider');
    expect(out.providerMessageId).toBeNull();
  });

  it('short-circuits to missing_from_address when EMAIL_FROM is unset', async () => {
    process.env.RESEND_API_KEY = 're_test';
    const out = await sendEmail({
      to: 'user@example.com',
      subject: 's',
      bodyText: 'b',
    });
    expect(out.sent).toBe(false);
    expect(out.reason).toBe('missing_from_address');
  });

  it('rejects an invalid recipient before calling the provider', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.EMAIL_FROM = 'ShipFlare <noreply@shipflare.dev>';
    const fetchSpy = vi.spyOn(global, 'fetch');
    const out = await sendEmail({
      to: 'not-an-email',
      subject: 's',
      bodyText: 'b',
    });
    expect(out.sent).toBe(false);
    expect(out.reason).toBe('invalid_recipient');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns sent=true with provider message id on 200', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.EMAIL_FROM = 'ShipFlare <noreply@shipflare.dev>';
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'msg-001' }), { status: 200 }),
    );
    const out = await sendEmail({
      to: 'user@example.com',
      subject: 's',
      bodyText: 'b',
    });
    expect(out.sent).toBe(true);
    expect(out.providerMessageId).toBe('msg-001');
    expect(out.reason).toBe('sent');
  });

  it('returns provider_error on a non-2xx', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.EMAIL_FROM = 'ShipFlare <noreply@shipflare.dev>';
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('bad request', { status: 400 }),
    );
    const out = await sendEmail({
      to: 'user@example.com',
      subject: 's',
      bodyText: 'b',
    });
    expect(out.sent).toBe(false);
    expect(out.reason).toBe('provider_error');
  });
});
