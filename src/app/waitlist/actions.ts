'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { db } from '@/lib/db';
import { waitlistSignups } from '@/lib/db/schema';
import { acquireRateLimit } from '@/lib/rate-limit';
import { sendEmail } from '@/lib/email';
import { waitlistAdminNotification } from '@/lib/email/templates/waitlist-admin-notification';
import { waitlistThankYou } from '@/lib/email/templates/waitlist-thank-you';
import { hashIp } from '@/lib/ip-hash';
import { createLogger } from '@/lib/logger';

const log = createLogger('waitlist:join');

const schema = z.object({
  email: z
    .string()
    .min(3)
    .max(254)
    .email()
    .transform((v) => v.trim().toLowerCase()),
  useCase: z
    .string()
    .max(500)
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  referer: z.enum(['denied', 'landing', 'no-email']).optional(),
  company: z.string().optional(), // honeypot — must be empty
});

export type JoinWaitlistState = {
  ok: boolean;
  error?: string;
  alreadyOnList?: boolean;
};

export async function joinWaitlist(
  _prev: JoinWaitlistState | undefined,
  formData: FormData,
): Promise<JoinWaitlistState> {
  const parsed = schema.safeParse({
    email: formData.get('email'),
    useCase: formData.get('useCase') ?? undefined,
    referer: formData.get('referer') ?? undefined,
    company: formData.get('company') ?? undefined,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please enter a valid email.',
    };
  }

  // Honeypot tripped — silent success so bots can't probe for the gate.
  if (parsed.data.company && parsed.data.company.trim() !== '') {
    log.info('honeypot tripped', {
      emailTag: parsed.data.email.slice(0, 3) + '***',
    });
    return { ok: true, alreadyOnList: false };
  }

  const rawIp =
    (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

  // If we can't identify the source, skip rate-limiting (rather than using
  // a shared 'unknown' bucket that would let one submit block everyone).
  // The honeypot + DB upsert idempotency still limit damage.
  if (rawIp) {
    const rl = await acquireRateLimit(`waitlist:${rawIp}`, 60);
    if (!rl.allowed) {
      return {
        ok: false,
        error: 'Too many requests. Try again in a minute.',
      };
    }
  }

  const ipHash = rawIp ? hashIp(rawIp) : null;

  const rows = await db
    .insert(waitlistSignups)
    .values({
      email: parsed.data.email,
      useCase: parsed.data.useCase,
      referer: parsed.data.referer ?? null,
      ipHash,
    })
    .onConflictDoUpdate({
      target: waitlistSignups.email,
      set: {
        useCase: parsed.data.useCase,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: waitlistSignups.id,
      createdAt: waitlistSignups.createdAt,
      updatedAt: waitlistSignups.updatedAt,
    });

  const row = rows[0];
  if (!row) {
    log.error('waitlist insert returned no row', {
      emailTag: parsed.data.email.slice(0, 3) + '***',
    });
    return { ok: false, error: 'Something went wrong. Try again.' };
  }

  // Treat as "new" if updatedAt is within 1s of createdAt.
  //
  // First-insert path: both columns are set by `defaultNow()` in the
  // same transaction → diff is effectively 0.
  //
  // Conflict path: `set: { updatedAt: new Date() }` uses Node's clock,
  // which will be at least milliseconds (usually seconds/minutes) ahead
  // of the original `createdAt` from Postgres `now()`, so the diff will
  // exceed 1s.
  //
  // The 1s tolerance handles edge cases where a brand-new row is
  // resubmitted within ~1s and the `new Date()` from the conflict path
  // happens to land sub-millisecond after the DB-side `now()`. Stricter
  // tolerance risks misclassifying. Looser risks suppressing legitimate
  // resubmit notifications.
  const isNew =
    Math.abs(row.updatedAt.getTime() - row.createdAt.getTime()) < 1000;

  if (isNew) {
    // Two emails go out in parallel:
    //   1. Admin notification to SUPER_ADMIN_EMAIL — "new waitlist signup"
    //   2. Thank-you to the applicant — confirms receipt + sets expectation
    //
    // Both are fire-and-forget. sendEmail() never throws (returns
    // {ok, reason}); the only place a throw can happen is the admin
    // template's hard-fail when SUPER_ADMIN_EMAIL is unset. We catch
    // that locally so the user's submission still returns ok:true.
    const adminP = (async () => {
      try {
        await sendEmail(
          waitlistAdminNotification({
            email: parsed.data.email,
            useCase: parsed.data.useCase,
            referer: parsed.data.referer ?? null,
          }),
        );
      } catch (err) {
        log.error('waitlist admin notification failed', {
          emailTag: parsed.data.email.slice(0, 3) + '***',
          err: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    const thankYouP = (async () => {
      try {
        await sendEmail(waitlistThankYou({ email: parsed.data.email }));
      } catch (err) {
        log.error('waitlist thank-you email failed', {
          emailTag: parsed.data.email.slice(0, 3) + '***',
          err: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    await Promise.all([adminP, thankYouP]);
  }

  return { ok: true, alreadyOnList: !isNew };
}
