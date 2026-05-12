'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { db } from '@/lib/db';
import { waitlistSignups } from '@/lib/db/schema';
import { acquireRateLimit } from '@/lib/rate-limit';
import { sendEmail } from '@/lib/email';
import { waitlistAdminNotification } from '@/lib/email/templates/waitlist-admin-notification';
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

  const ip =
    (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';
  const rl = await acquireRateLimit(`waitlist:${ip}`, 60);
  if (!rl.allowed) {
    return {
      ok: false,
      error: 'Too many requests. Try again in a minute.',
    };
  }

  const ipHash = hashIp(ip);

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

  // Treat as "new" if updatedAt is within 1s of createdAt. ON CONFLICT
  // path always bumps updatedAt with `new Date()` (Node clock) while
  // createdAt was set by Postgres `now()` (DB clock) — the 1s tolerance
  // covers clock skew. Theoretical race: two simultaneous submits within
  // ~1ms produce two notifications for the same email. Acceptable for
  // alpha; tighten if it becomes a real problem.
  const isNew =
    Math.abs(row.updatedAt.getTime() - row.createdAt.getTime()) < 1000;

  if (isNew) {
    try {
      await sendEmail(
        waitlistAdminNotification({
          email: parsed.data.email,
          useCase: parsed.data.useCase,
          referer: parsed.data.referer ?? null,
        }),
      );
    } catch (err) {
      // Notification failure must not surface to the user — the signup row
      // is already committed. Most likely cause: SUPER_ADMIN_EMAIL unset.
      log.error('waitlist admin notification failed', {
        emailTag: parsed.data.email.slice(0, 3) + '***',
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok: true, alreadyOnList: !isNew };
}
