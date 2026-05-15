import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { products, eq } from "@shipflare/db";
import { getAuth } from "@/auth";
import { getDb } from "@/db";
import { OnboardingFlow } from "./_components/OnboardingFlow";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Onboarding — ShipFlare",
};

export default async function OnboardingPage() {
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch {
    session = null;
  }
  if (!session?.user) redirect("/");

  const { env } = getCloudflareContext();
  const db = getDb(env);
  const existing = await db
    .select()
    .from(products)
    .where(eq(products.userId, session.user.id))
    .get();

  // If onboarding has already been completed, skip the flow and route the
  // founder to the briefing. Re-onboarding lives at /product (edit page).
  if (existing?.onboardingCompletedAt) {
    redirect("/briefing");
  }

  return <OnboardingFlow />;
}
