import type { Metadata } from "next";
import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";
import { resolveCoreHost } from "@/lib/core-host";
import { HistoryTab } from "../_components/history-tab";

export const metadata: Metadata = { title: "Briefing — History" };
export const dynamic = "force-dynamic";

export default async function BriefingHistoryPage() {
  const { env } = getCloudflareContext();
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch (err) {
    console.error("[BriefingHistoryPage] getSession failed", err);
  }
  if (!session?.user) return null;
  return (
    <HistoryTab
      userId={session.user.id}
      coreHost={resolveCoreHost(env.CORE_PUBLIC_URL)}
    />
  );
}
