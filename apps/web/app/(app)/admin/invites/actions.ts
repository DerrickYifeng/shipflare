"use server";

import { revalidatePath } from "next/cache";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  allowedEmails,
  waitlistSignups,
  session as sessionTable,
  user as userTable,
  and,
  eq,
  isNull,
  sql,
} from "@shipflare/db";
import { getDb } from "@/db";
import { requireAdmin } from "@/lib/admin";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalize(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length < 3 || trimmed.length > 254) return null;
  if (!EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Add a new invite. Idempotent — re-adding an existing email un-revokes
 * it and refreshes the note.
 */
export async function addInvite(formData: FormData): Promise<ActionResult> {
  let adminEmail: string;
  try {
    adminEmail = await requireAdmin();
  } catch {
    return { ok: false, error: "forbidden" };
  }

  const email = normalize(formData.get("email")?.toString());
  if (!email) return { ok: false, error: "Invalid email." };
  const rawNote = formData.get("note")?.toString() ?? "";
  const note = rawNote.length === 0 ? null : rawNote.slice(0, 500);

  const { env } = getCloudflareContext();
  const db = getDb(env);
  await db
    .insert(allowedEmails)
    .values({
      email,
      invitedBy: adminEmail,
      note,
      invitedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: allowedEmails.email,
      set: { revokedAt: null, note, invitedBy: adminEmail },
    });

  revalidatePath("/admin/invites");
  return { ok: true };
}

/**
 * Revoke an invite (soft-delete via `revokedAt`). Also kills any active
 * sessions for the matching user so the partner is bounced on the very
 * next request, not on cookie expiry. SUPER_ADMIN_EMAIL can never be
 * revoked — that bypass is a safety net the UI should not be able to
 * wipe out.
 */
export async function revokeInvite(formData: FormData): Promise<ActionResult> {
  let adminEmail: string;
  try {
    adminEmail = await requireAdmin();
  } catch {
    return { ok: false, error: "forbidden" };
  }

  const email = normalize(formData.get("email")?.toString());
  if (!email) return { ok: false, error: "Invalid email." };

  const { env } = getCloudflareContext();
  const superAdmin = env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  if (superAdmin && email === superAdmin) {
    return { ok: false, error: "cannot revoke SUPER_ADMIN_EMAIL" };
  }

  const db = getDb(env);
  await db
    .update(allowedEmails)
    .set({ revokedAt: new Date() })
    .where(eq(allowedEmails.email, email));

  // Bounce any active sessions for the matching user account. Joined via
  // user.email (lowercased) so we don't need to pre-fetch the userId.
  await db
    .delete(sessionTable)
    .where(
      sql`${sessionTable.userId} IN (SELECT ${userTable.id} FROM ${userTable} WHERE LOWER(${userTable.email}) = ${email})`,
    );

  console.info(`[admin] invite revoked: ${email} by ${adminEmail}`);
  revalidatePath("/admin/invites");
  return { ok: true };
}

/**
 * Approve a waitlist signup → upsert into allowed_emails (un-revoke on
 * conflict) and stamp the waitlist row with approved_at/approved_by.
 *
 * D1 does not support real cross-statement transactions, so we run the
 * insert first and the stamp second; an interrupted run leaves the row
 * in the allowlist without the waitlist stamp, which an admin can clean
 * up via the Approved filter. Acceptable for an MVP.
 */
export async function approveWaitlistSignup(
  id: string,
): Promise<ActionResult> {
  let adminEmail: string;
  try {
    adminEmail = await requireAdmin();
  } catch {
    return { ok: false, error: "forbidden" };
  }

  const { env } = getCloudflareContext();
  const db = getDb(env);

  const row = await db
    .select({ id: waitlistSignups.id, email: waitlistSignups.email })
    .from(waitlistSignups)
    .where(eq(waitlistSignups.id, id))
    .get();
  if (!row) return { ok: false, error: "Waitlist row not found." };

  const email = normalize(row.email);
  if (!email) return { ok: false, error: "Stored email is invalid." };

  await db
    .insert(allowedEmails)
    .values({
      email,
      invitedBy: adminEmail,
      note: "Approved from waitlist",
      invitedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: allowedEmails.email,
      set: { revokedAt: null, invitedBy: adminEmail },
    });

  await db
    .update(waitlistSignups)
    .set({ approvedAt: new Date(), approvedBy: adminEmail })
    .where(
      and(
        eq(waitlistSignups.id, row.id),
        isNull(waitlistSignups.approvedAt),
      ),
    );

  console.info(`[admin] waitlist approved: ${email} by ${adminEmail}`);
  revalidatePath("/admin/invites");
  return { ok: true };
}

/**
 * Soft-dismiss a waitlist signup. No email sent — reversible by the
 * admin from the Dismissed filter view.
 */
export async function dismissWaitlistSignup(
  id: string,
): Promise<ActionResult> {
  let adminEmail: string;
  try {
    adminEmail = await requireAdmin();
  } catch {
    return { ok: false, error: "forbidden" };
  }

  const { env } = getCloudflareContext();
  const db = getDb(env);

  await db
    .update(waitlistSignups)
    .set({ dismissedAt: new Date(), dismissedBy: adminEmail })
    .where(
      and(
        eq(waitlistSignups.id, id),
        isNull(waitlistSignups.approvedAt),
        isNull(waitlistSignups.dismissedAt),
      ),
    );

  revalidatePath("/admin/invites");
  return { ok: true };
}
