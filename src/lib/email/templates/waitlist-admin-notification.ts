import { escapeHtml } from '../escape-html';
import type { EmailPayload } from '../index';

export interface AdminNotificationInput {
  email: string;
  useCase: string | null;
  referer: string | null;
}

export function waitlistAdminNotification(
  input: AdminNotificationInput,
): EmailPayload {
  const adminEmail = process.env.SUPER_ADMIN_EMAIL;
  if (!adminEmail || adminEmail.trim() === '') {
    throw new Error(
      'waitlistAdminNotification: SUPER_ADMIN_EMAIL is not configured',
    );
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://shipflare.app';
  const useCase = input.useCase ?? '(none)';
  const source = input.referer ?? '(none)';

  const text = [
    'New ShipFlare waitlist signup',
    '',
    `From: ${input.email}`,
    `Source: ${source}`,
    `Use case: ${useCase}`,
    '',
    `Review: ${appUrl}/admin/invites?tab=waitlist`,
  ].join('\n');

  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">
  <p><strong>New ShipFlare waitlist signup</strong></p>
  <p>From: <a href="mailto:${escapeHtml(input.email)}">${escapeHtml(input.email)}</a><br>
  Source: ${escapeHtml(source)}<br>
  Use case: ${escapeHtml(useCase)}</p>
  <p><a href="${escapeHtml(appUrl + '/admin/invites?tab=waitlist')}">Review in admin</a></p>
</div>`;

  return {
    to: adminEmail,
    subject: `[ShipFlare] Waitlist signup: ${input.email.replace(/[\r\n]/g, '')}`,
    text,
    html,
  };
}
