import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted Resend mock — set per-test
const sendMock = vi.fn();
vi.mock('resend', () => {
  const ResendMock = vi.fn(function (this: { emails: { send: typeof sendMock } }) {
    this.emails = { send: sendMock };
  });
  return { Resend: ResendMock };
});

describe('sendEmail', () => {
  const ORIGINAL_KEY = process.env.RESEND_API_KEY;
  const ORIGINAL_FROM = process.env.EMAIL_FROM;

  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = ORIGINAL_KEY;
    if (ORIGINAL_FROM === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = ORIGINAL_FROM;
  });

  it('returns ok:false with reason "not_configured" when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    process.env.EMAIL_FROM = 'alpha@mail.test';
    const { sendEmail } = await import('../index');
    const result = await sendEmail({
      to: 'someone@example.com',
      subject: 'hi',
      text: 'body',
    });
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns ok:false with reason "missing_from" when EMAIL_FROM is missing', async () => {
    process.env.RESEND_API_KEY = 'rk_test';
    delete process.env.EMAIL_FROM;
    const { sendEmail } = await import('../index');
    const result = await sendEmail({
      to: 'someone@example.com',
      subject: 'hi',
      text: 'body',
    });
    expect(result).toEqual({ ok: false, reason: 'missing_from' });
  });

  it('forwards the payload to Resend and returns the id on success', async () => {
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = 'alpha@mail.test';
    sendMock.mockResolvedValueOnce({ data: { id: 'email_123' }, error: null });
    const { sendEmail } = await import('../index');
    const result = await sendEmail({
      to: 'someone@example.com',
      subject: 'hi',
      text: 'body',
    });
    expect(result).toEqual({ ok: true, id: 'email_123' });
    expect(sendMock).toHaveBeenCalledWith({
      from: 'alpha@mail.test',
      to: 'someone@example.com',
      subject: 'hi',
      text: 'body',
    });
  });

  it('returns ok:false and does not throw when Resend rejects', async () => {
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = 'alpha@mail.test';
    sendMock.mockRejectedValueOnce(new Error('network down'));
    const { sendEmail } = await import('../index');
    const result = await sendEmail({
      to: 'someone@example.com',
      subject: 'hi',
      text: 'body',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('network down');
    }
  });

  it('returns ok:false with the error message when Resend returns an error object', async () => {
    process.env.RESEND_API_KEY = 'rk_test';
    process.env.EMAIL_FROM = 'alpha@mail.test';
    sendMock.mockResolvedValueOnce({
      data: null,
      error: {
        message: 'invalid_from_address',
        statusCode: 422,
        name: 'invalid_from_address',
      },
    });
    const { sendEmail } = await import('../index');
    const result = await sendEmail({
      to: 'someone@example.com',
      subject: 'hi',
      text: 'body',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_from_address');
    }
  });
});
