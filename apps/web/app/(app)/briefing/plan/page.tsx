import type { Metadata } from "next";
import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuth } from "@/auth";
import { resolveCoreHost } from "@/lib/core-host";
import { PlanTab } from "../_components/plan-tab";

export const metadata: Metadata = { title: "Briefing — Plan" };
export const dynamic = "force-dynamic";

export default async function BriefingPlanPage() {
  const { env } = getCloudflareContext();
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch (err) {
    console.error("[BriefingPlanPage] getSession failed", err);
  }
  if (!session?.user) return null;
  return (
    <PlanTab
      userId={session.user.id}
      coreHost={resolveCoreHost(env.CORE_PUBLIC_URL)}
    />
  );
}
