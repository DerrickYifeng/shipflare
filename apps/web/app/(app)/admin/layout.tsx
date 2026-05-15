/**
 * Admin-scope layout. Rejects non-admin users with `notFound()` (which
 * renders a 404) rather than a 403 so the existence of /admin/* isn't
 * advertised publicly. ADMIN_EMAILS env var lists the allowlisted emails
 * (comma-separated, case-insensitive); SUPER_ADMIN_EMAIL is also admin.
 */

import type { ReactNode } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getAuth } from "@/auth";
import { isAdminEmail } from "@/lib/admin";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch {
    session = null;
  }
  if (!isAdminEmail(session?.user?.email ?? null)) {
    notFound();
  }

  return (
    <section
      style={{
        padding: "32px 40px",
        maxWidth: 1200,
        margin: "0 auto",
      }}
    >
      <header
        style={{
          borderBottom: "1px solid var(--sf-border)",
          paddingBottom: 20,
          marginBottom: 28,
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontFamily: "var(--sf-font-mono)",
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: "var(--sf-fg-3)",
            marginBottom: 6,
          }}
        >
          Admin
        </div>
        <h1
          style={{
            margin: 0,
            fontFamily: "var(--sf-font-display)",
            fontSize: 24,
            fontWeight: 500,
            letterSpacing: "var(--sf-track-tight)",
            color: "var(--sf-fg-1)",
          }}
        >
          Invites & Waitlist
        </h1>
      </header>
      {children}
    </section>
  );
}
