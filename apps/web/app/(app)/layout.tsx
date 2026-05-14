/**
 * `(app)` route group layout — wraps every authenticated page (chat, team,
 * plan, drafts, settings) with a session gate + a shared nav bar.
 *
 * Route groups (`(name)`) don't add URL segments — they just nest a layout
 * around a subtree. Anything that lives in `app/(app)/...` is protected;
 * anything outside (like the landing page) stays public.
 *
 * The session check runs on the server so an unauthenticated user is
 * redirected before the client bundle loads — no flash of authed content.
 */

import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuth } from "@/auth";

interface AppLayoutProps {
  children: ReactNode;
}

export default async function AppLayout({ children }: AppLayoutProps) {
  const auth = getAuth();
  // `headers()` is async in Next 16. Pass the headers map straight into
  // Better Auth's `getSession` — it pulls the session cookie itself.
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/");
  }

  return (
    <div>
      <nav
        style={{
          padding: "1rem",
          borderBottom: "1px solid #eee",
          display: "flex",
          gap: "1rem",
          alignItems: "center",
        }}
      >
        <Link href="/chat">Chat</Link>
        <Link href="/team">Team</Link>
        <Link href="/plan">Plan</Link>
        <Link href="/drafts">Drafts</Link>
        <Link href="/mcp-urls">MCP URLs</Link>
        <Link href="/settings/channels">Settings</Link>
        <span style={{ marginLeft: "auto" }}>
          Signed in as <strong>{session.user.email}</strong>
        </span>
      </nav>
      <main style={{ padding: "2rem" }}>{children}</main>
    </div>
  );
}
