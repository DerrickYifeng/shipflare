'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { allowedEmails, sessions, users } from '@/lib/db/schema';
import { requireAdmin } from '@/lib/admin';
import { normalizeEmail, getSuperAdminEmail } from '@/lib/auth/allowlist';
import { createLogger } from '@/lib/logger';

const log = createLogger('admin:invites');

// Normalize FIRST so trailing whitespace + case don't trip `.email()`.
// `z.preprocess` runs before any other validation step.
const emailField = z.preprocess(
  (v) => (typeof v === 'string' ? normalizeEmail(v) : v),
  z.string().min(3).max(254).email(),
);

const noteField = z.string().max(500).optional();

const addSchema = z.object({ email: emailField, note: noteField });
const revokeSchema = z.object({ email: emailField });
const updateNoteSchema = z.object({ email: emailField, note: z.string().max(500) });

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Add a new invite. If a row already exists for this email — even one
 * that's been revoked — un-revoke it (sets revokedAt back to null) and
 * refresh the note. Idempotent so the operator can paste the same email
 * twice without error.
 */
export async function addInvite(formData: FormData): Promise<ActionResult> {
  const adminEmail = await requireAdmin();

  const parsed = addSchema.safeParse({
    email: formData.get('email'),
    note: formData.get('note') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  }
  const { email, note } = parsed.data;

  await db
    .insert(allowedEmails)
    .values({ email, invitedBy: adminEmail, note: note ?? null })
    .onConflictDoUpdate({
      target: allowedEmails.email,
      set: { revokedAt: null, note: note ?? null, invitedBy: adminEmail },
    });

  log.info(`invite added: ${email} by ${adminEmail}`);
  revalidatePath('/admin/invites');
  return { ok: true };
}

/**
 * Revoke an invite (soft-delete via `revokedAt`). Refuses to revoke the
 * SUPER_ADMIN_EMAIL — that bypass is a safety net the founder should
 * not be able to wipe out from the UI.
 *
 * Also deletes any active session rows for the matching user so the
 * partner is bounced on their next request, not on next cookie expiry.
 */
export async function revokeInvite(formData: FormData): Promise<ActionResult> {
  const adminEmail = await requireAdmin();

  const parsed = revokeSchema.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  }
  const { email } = parsed.data;

  if (email === getSuperAdminEmail()) {
    return { ok: false, error: 'cannot revoke SUPER_ADMIN_EMAIL' };
  }

  await db
    .update(allowedEmails)
    .set({ revokedAt: new Date() })
    .where(eq(allowedEmails.email, email));

  // Immediate kickout: delete any active session rows. Joined via
  // `users.email` so we don't need to fetch the userId first.
  await db
    .delete(sessions)
    .where(
      sql`${sessions.userId} IN (SELECT ${users.id} FROM ${users} WHERE LOWER(${users.email}) = ${email})`,
    );

  log.info(`invite revoked: ${email} by ${adminEmail}`);
  revalidatePath('/admin/invites');
  return { ok: true };
}

/**
 * Update the per-invite note. Allows empty string to clear the note.
 */
export async function updateNote(formData: FormData): Promise<ActionResult> {
  const adminEmail = await requireAdmin();

  const parsed = updateNoteSchema.safeParse({
    email: formData.get('email'),
    note: formData.get('note') ?? '',
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  }
  const { email, note } = parsed.data;

  await db
    .update(allowedEmails)
    .set({ note: note === '' ? null : note })
    .where(and(eq(allowedEmails.email, email)));

  log.info(`invite note updated: ${email} by ${adminEmail}`);
  revalidatePath('/admin/invites');
  return { ok: true };
}
