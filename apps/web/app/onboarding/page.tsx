import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { products, eq } from "@shipflare/db";
import { getAuth } from "@/auth";
import { getDb } from "@/db";
import { OnboardingForm } from "./_components/onboarding-form";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Onboarding — ShipFlare",
};

export default async function OnboardingPage() {
  // Auth gate — unauthenticated users get bounced to the landing page.
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch {
    session = null;
  }
  if (!session?.user) redirect("/");

  // If the founder already has a product, skip onboarding and send them
  // straight to the briefing. Re-onboarding lives at /product (edit page)
  // for now.
  const { env } = getCloudflareContext();
  const db = getDb(env);
  const existing = await db
    .select()
    .from(products)
    .where(eq(products.userId, session.user.id))
    .get();
  if (existing && existing.name) {
    redirect("/briefing");
  }

  return (
    <OnboardingForm
      initialName={existing?.name ?? ""}
      initialUrl={existing?.url ?? ""}
      initialDescription={existing?.description ?? ""}
    />
  );
}
