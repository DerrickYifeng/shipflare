import { createLogger } from '@/lib/logger';
import {
  sendEmailOutputSchema,
  type SendEmailOutput,
} from '@/agents/schemas';

const log = createLogger('skill:send-email');

export interface SendEmailInput {
  to: string;
  from?: string;
  replyTo?: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  tag?: string;
  idempotencyKey?: string;
}

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * Send one email via the configured provider.
 *
 * Short-circuits with `{ sent: false, reason: 'no_provider' }` when
 * `RESEND_API_KEY` is missing — dev / preview environments and CLI scripts
 * must keep working without hitting a real provider. Callers treat that as
 * a non-error state. Only hard HTTP failures return `provider_error`.
 */
export async function sendEmail(
  input: SendEmailInput,
): Promise<SendEmailOutput> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.info(
      `skip send to ${input.to}: RESEND_API_KEY not configured (dev / preview)`,
    );
    return sendEmailOutputSchema.parse({
      sent: false,
      providerMessageId: null,
      reason: 'no_provider',
    });
  }

  const from = input.from ?? process.env.EMAIL_FROM;
  if (!from) {
    log.warn(`skip send to ${input.to}: EMAIL_FROM not configured`);
    return sendEmailOutputSchema.parse({
      sent: false,
      providerMessageId: null,
      reason: 'missing_from_address',
    });
  }

  if (!input.to.includes('@')) {
    log.warn(`invalid recipient ${input.to}`);
    return sendEmailOutputSchema.parse({
      sent: false,
      providerMessageId: null,
      reason: 'invalid_recipient',
    });
  }

  const body = {
    from,
    to: [input.to],
    subject: input.subject,
    text: input.bodyText,
    ...(input.bodyHtml ? { html: input.bodyHtml } : {}),
    ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    ...(input.tag ? { tags: [{ name: 'kind', value: input.tag }] } : {}),
  };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (input.idempotencyKey) {
    headers['Idempotency-Key'] = input.idempotencyKey;
  }

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      log.error(
        `Resend responded ${res.status} for ${input.to}: ${detail.slice(0, 200)}`,
      );
      return sendEmailOutputSchema.parse({
        sent: false,
        providerMessageId: null,
        reason: 'provider_error',
      });
    }

    const payload = (await res.json().catch(() => ({}))) as { id?: string };
    const id = typeof payload.id === 'string' ? payload.id : null;
    log.info(`sent email to ${input.to} (id=${id ?? 'unknown'})`);
    return sendEmailOutputSchema.parse({
      sent: true,
      providerMessageId: id,
      reason: 'sent',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`send failed for ${input.to}: ${message}`);
    return sendEmailOutputSchema.parse({
      sent: false,
      providerMessageId: null,
      reason: 'provider_error',
    });
  }
}
