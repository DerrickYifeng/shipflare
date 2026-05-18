/**
 * `/briefing` — founder's daily approval inbox.
 *
 * Ported from Railway. Data fetching replaced: Railway used SWR +
 * `/api/today` (Postgres). CF uses browser→core via useCmoAgent +
 * useCmoStub (CF spec D13 / Task 11 callable RPC migration).
 *
 * Auth gate lives in `(app)/layout.tsx` — this page is always protected,
 * but we re-read the session here to pass `userId` and `coreHost` down to
 * the client tab (browser bundle has no env access).
 */

import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";
import { resolveCoreHost } from "@/lib/core-host";
import { TodayTab } from "./_components/today-tab";

export const dynamic = "force-dynamic";

export default async function BriefingPage() {
  const { env } = getCloudflareContext();
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch (err) {
    console.error("[BriefingPage] getSession failed", err);
  }
  if (!session?.user) return null;
  return (
    <TodayTab
      userId={session.user.id}
      coreHost={resolveCoreHost(env.CORE_PUBLIC_URL)}
    />
  );
}
