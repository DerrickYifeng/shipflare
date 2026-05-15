import { Resend } from 'resend';
import { createLogger } from '@/lib/logger';

const log = createLogger('lib:email');

export interface EmailPayload {
  to: string | string[];
  subject: string;
  html?: string;
  text: string;
  replyTo?: string;
  tags?: { name: string; value: string }[];
}

export type SendEmailResult =
  | { ok: true; id?: string }
  | { ok: false; reason: string };

let client: Resend | null = null;
function getClient(): Resend | null {
  if (client) return client;
  const key = process.env.RESEND_API_KEY;
  if (!key || key.trim() === '') return null;
  client = new Resend(key);
  return client;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

/**
 * Send an email via Resend. Server-only. Never throws — returns a
 * result struct so callers can decide whether to surface or swallow.
 *
 * Gracefully no-ops (returns `{ ok: false, reason: 'not_configured' }`)
 * when `RESEND_API_KEY` is unset. This keeps local development frictionless
 * and lets the waitlist server action call `sendEmail` regardless of
 * whether prod env vars are set yet.
 *
 * `EMAIL_FROM` must be set to a verified Resend sender. If unset,
 * returns `{ ok: false, reason: 'missing_from' }`.
 */
export async function sendEmail(payload: EmailPayload): Promise<SendEmailResult> {
  const c = getClient();
  if (!c) {
    log.warn('email skipped — RESEND_API_KEY not configured', {
      to: payload.to,
      subject: payload.subject,
    });
    return { ok: false, reason: 'not_configured' };
  }
  const from = process.env.EMAIL_FROM;
  if (!from || from.trim() === '') {
    log.error('EMAIL_FROM not configured but RESEND_API_KEY is set');
    return { ok: false, reason: 'missing_from' };
  }

  try {
    const result = await c.emails.send({ from, ...payload });
    if (result.error) {
      log.error('email send failed', { error: result.error });
      return { ok: false, reason: result.error.message };
    }
    return { ok: true, id: result.data?.id };
  } catch (err: unknown) {
    log.error('email send threw', {
      error: getErrorMessage(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return { ok: false, reason: getErrorMessage(err) };
  }
}
