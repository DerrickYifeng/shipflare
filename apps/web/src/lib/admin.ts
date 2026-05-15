/**
 * Admin gate helper.
 *
 * `ADMIN_EMAILS` env var holds a comma-separated list of admin addresses
 * (case-insensitive). `SUPER_ADMIN_EMAIL` is always admin. Both env vars
 * are optional — without either, no email is admin and every /admin/*
 * route 404s.
 *
 * Used by:
 *   - `apps/web/app/(app)/admin/layout.tsx` (layout 404s non-admins).
 *   - Server actions in `apps/web/app/(app)/admin/invites/actions.ts`
 *     (re-check via `requireAdmin()` because the layout's check is one-
 *     shot at navigation time; an action could be hit later by a stale
 *     session).
 */

import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";

function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function adminEmails(env: CloudflareEnv): Set<string> {
  const set = new Set<string>();
  const superAdmin = normalizeEmail(env.SUPER_ADMIN_EMAIL);
  if (superAdmin) set.add(superAdmin);
  const raw = env.ADMIN_EMAILS;
  if (raw && raw.trim() !== "") {
    for (const part of raw.split(",")) {
      const norm = normalizeEmail(part);
      if (norm) set.add(norm);
    }
  }
  return set;
}

/**
 * True if `email` is configured as an admin. Synchronous, env-only — does
 * not query the DB.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  try {
    const { env } = getCloudflareContext();
    return adminEmails(env).has(normalized);
  } catch {
    // Outside of a CF context (rare — possibly during build-time analysis).
    return false;
  }
}

/**
 * Throws (returning Promise<never>) if the current session is not admin.
 * Returns the admin's normalized email so server actions can record who
 * performed the operation.
 */
export async function requireAdmin(): Promise<string> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  const email = normalizeEmail(session?.user?.email);
  if (!email || !isAdminEmail(email)) {
    throw new Error("forbidden");
  }
  return email;
}
