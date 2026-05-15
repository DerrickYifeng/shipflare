import type { EmailPayload } from '../index';
import { escapeHtml } from '../escape-html';

export interface ThankYouInput {
  email: string;
}

/**
 * Sent immediately after a user submits the waitlist form.
 *
 * Confirms receipt + sets expectation that we're inviting in waves.
 * Sentence-case subject, plain-text body first, HTML fallback for clients
 * that prefer it. Voice matches the rest of the system: direct, calm,
 * no breathless urgency.
 */
export function waitlistThankYou(input: ThankYouInput): EmailPayload {
  const text = [
    "Thanks for requesting ShipFlare alpha access.",
    '',
    "You're on the waitlist. We're inviting design partners in waves —",
    "you'll hear from us when a slot opens for you.",
    '',
    "In the meantime, reply to this email if you want to tell us more",
    "about what you're building. The more we know, the better we can",
    "prioritize.",
    '',
    "— ShipFlare",
  ].join('\n');

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1d1d1f;max-width:560px">
  <p style="margin:0 0 16px"><strong>Thanks for requesting ShipFlare alpha access.</strong></p>
  <p style="margin:0 0 16px">You&rsquo;re on the waitlist. We&rsquo;re inviting design partners in waves &mdash; you&rsquo;ll hear from us when a slot opens for you.</p>
  <p style="margin:0 0 16px">In the meantime, reply to this email if you want to tell us more about what you&rsquo;re building. The more we know, the better we can prioritize.</p>
  <p style="margin:24px 0 0;color:rgba(0,0,0,0.48)">&mdash; ShipFlare</p>
</div>`;

  return {
    to: input.email,
    subject: "You're on the ShipFlare alpha waitlist",
    text,
    html,
    // Use a sane reply target so users who reply land somewhere a human reads.
    // Defaults to EMAIL_FROM (set by sendEmail).
    tags: [
      { name: 'kind', value: 'waitlist_thankyou' },
      { name: 'surface', value: escapeHtml('waitlist_form') },
    ],
  };
}
