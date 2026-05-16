import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { getAuth } from "@/auth";
import { GlassNav } from "@/components/marketing/glass-nav";
import { FooterStrip } from "@/components/marketing/footer-strip";
import { ContextBanner, type BannerVariant } from "./_components/context-banner";
import { WaitlistForm } from "./_components/waitlist-form";

export const dynamic = "force-dynamic";

interface WaitlistPageProps {
  searchParams: Promise<{
    from?: string;
    email?: string;
    reason?: string;
  }>;
}

export const metadata = {
  title: "Request alpha access — ShipFlare",
  robots: { index: false, follow: false },
};

const emailSchema = z.string().email().max(254);

export default async function WaitlistPage({ searchParams }: WaitlistPageProps) {
  // Already signed in → no point showing the waitlist. Drop them at the
  // briefing (which itself gates on onboarding-completion).
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: await headers() });
  } catch {
    session = null;
  }
  if (session?.user) redirect("/briefing");

  const sp = await searchParams;

  // Variant drives ContextBanner copy. `?reason=no-email` (sign-in came back
  // without an email) wins; `?from=denied` (allowlist rejected) is the
  // common path; everything else is the landing variant.
  const variant: BannerVariant =
    sp.reason === "no-email"
      ? "no-email"
      : sp.from === "denied"
        ? "denied"
        : "landing";

  // Pre-fill email only if it parses cleanly — XSS guard against ?email=<script>
  const parsed = emailSchema.safeParse(sp.email);
  const initialEmail = parsed.success ? parsed.data : "";

  return (
    <main
      className="min-h-screen flex flex-col"
      style={{ background: "var(--sf-bg-dark)" }}
    >
      <GlassNav isAuthenticated={false} />
      <div className="flex-1 flex flex-col">
        <ContextBanner variant={variant} />
        <WaitlistForm initialEmail={initialEmail} referer={variant} />
      </div>
      <FooterStrip />
    </main>
  );
}
