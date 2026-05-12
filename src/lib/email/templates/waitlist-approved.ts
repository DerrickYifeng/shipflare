import { escapeHtml } from '../escape-html';
import type { EmailPayload } from '../index';

export interface ApprovedInput {
  email: string;
}

export function waitlistApproved(input: ApprovedInput): EmailPayload {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://shipflare.ai';

  const text = [
    "You're in.",
    '',
    `Your ShipFlare alpha invite is ready. Sign in using ${input.email}:`,
    appUrl,
    '',
    'Reply to this email if you run into trouble.',
  ].join('\n');

  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">
  <p><strong>You're in.</strong></p>
  <p>Your ShipFlare alpha invite is ready. Sign in using <code>${escapeHtml(input.email)}</code>:</p>
  <p><a href="${escapeHtml(appUrl)}">${escapeHtml(appUrl)}</a></p>
  <p>Reply to this email if you run into trouble.</p>
</div>`;

  return {
    to: input.email,
    subject: "You're in — ShipFlare alpha invite",
    text,
    html,
  };
}
