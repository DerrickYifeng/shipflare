/**
 * `(app)` route group layout — wraps every authenticated page with a session
 * gate + the full ShipFlare shell (Sidebar, TopNav, providers).
 *
 * Route groups (`(name)`) don't add URL segments — they just nest a layout
 * around a subtree. Anything that lives in `app/(app)/...` is protected;
 * anything outside (like the landing page) stays public.
 *
 * The session check runs on the server so an unauthenticated user is
 * redirected before the client bundle loads — no flash of authed content.
 */

import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { products, eq } from "@shipflare/db";
import { getAuth } from "@/auth";
import { getDb } from "@/db";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { ShellChromeProvider } from "@/components/layout/shell-chrome";
import { ToastProvider } from "@/components/ui/toast";
import { AppShell, AppCanvas } from "@/components/layout/app-shell";
import { Sidebar } from "@/components/layout/sidebar";
import { TopNav } from "@/components/layout/top-nav";

/**
 * Force every (app) route to be rendered per-request. Without this, Next 16
 * tries to statically prerender protected routes at build time, and
 * `getCloudflareContext()` (called inside `getAuth()`) throws because
 * there's no Workers runtime context during the static export pass.
 *
 * Propagates to every child route via Next's layout-level config inheritance.
 */
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch (err) {
    // Surface infra errors to logs without crashing the layout.
    // Unauthenticated visitors will still redirect to "/" via the
    // !session?.user check below.
    console.error("[AppLayout] getSession failed", err);
    session = null;
  }
  if (!session?.user) redirect("/");

  // Onboarding gate — every (app) route requires a product row with at
  // least a name. Without it, send the founder to /onboarding to fill it
  // in before they see any of the dashboard.
  const { env } = getCloudflareContext();
  const db = getDb(env);
  const product = await db
    .select({ name: products.name })
    .from(products)
    .where(eq(products.userId, session.user.id))
    .get();
  if (!product || !product.name) {
    redirect("/onboarding");
  }

  const user = {
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    image: session.user.image ?? null,
  };

  return (
    <SWRConfig
      value={{
        dedupingInterval: 5_000,
        focusThrottleInterval: 10_000,
        revalidateOnFocus: false,
      }}
    >
      <ThemeProvider>
        <ShellChromeProvider>
          <ToastProvider>
            <AppShell>
              <Sidebar user={user} />
              <AppCanvas>
                <TopNav userImage={user.image} />
                <main className="sf-app-main">{children}</main>
              </AppCanvas>
            </AppShell>
          </ToastProvider>
        </ShellChromeProvider>
      </ThemeProvider>
    </SWRConfig>
  );
}
